export const config = {
  api: {
    bodyParser: { sizeLimit: "4mb" },
    responseLimit: false
  },
  maxDuration: 60
};

const MODEL = "@cf/black-forest-labs/flux-2-klein-4b";
const allowedSizes = new Set(["1024x1024", "1024x1536", "1536x1024"]);

function decodeBase64(value) {
  const clean = value.includes(",") ? value.split(",").pop() : value;
  return Buffer.from(clean, "base64");
}

async function generateOne({ accountId, token, imageBytes, prompt, width, height }) {
  const form = new FormData();
  form.append("prompt", prompt);
  form.append("input_image_0", new Blob([imageBytes], { type: "image/jpeg" }), "reference.jpg");
  form.append("width", String(width));
  form.append("height", String(height));
  form.append("guidance", "4");

  const upstream = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${MODEL}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(50000)
    }
  );

  const payload = await upstream.json().catch(() => ({}));
  if (!upstream.ok || payload.success === false) {
    const detail = payload?.errors?.[0]?.message || payload?.error || "Cloudflare Workers AI gagal memproses gambar.";
    const err = new Error(detail);
    err.status = upstream.status || 502;
    throw err;
  }

  const image = payload?.result?.image || payload?.result?.data?.[0]?.b64_json;
  if (typeof image !== "string" || !image.length) {
    throw new Error("Cloudflare tidak mengembalikan gambar. Silakan coba lagi.");
  }
  return image.startsWith("data:") ? image.split(",").pop() : image;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Metode tidak diizinkan." });

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) {
    return res.status(503).json({ error: "Cloudflare belum dikonfigurasi. Periksa CLOUDFLARE_ACCOUNT_ID dan CLOUDFLARE_API_TOKEN di Vercel." });
  }

  try {
    const { imageBase64, prompt, size, count, tool, faceLock, productLock, lighting, retouchProfile, retouchStrength, backgroundMode } = req.body || {};
    if (typeof imageBase64 !== "string" || imageBase64.length < 100) {
      return res.status(400).json({ error: "Foto tidak valid. Silakan unggah ulang." });
    }
    if (imageBase64.length > 3_900_000) {
      return res.status(413).json({ error: "Foto terlalu besar. Silakan unggah ulang dengan ukuran lebih kecil." });
    }
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 1500) {
      return res.status(400).json({ error: "Prompt wajib diisi dan maksimal 1.500 karakter." });
    }

    const imageBytes = decodeBase64(imageBase64);
    if (imageBytes.length < 50 || imageBytes.length > 2_900_000) {
      return res.status(413).json({ error: "Ukuran foto referensi tidak sesuai batas." });
    }

    const outputSize = allowedSizes.has(size) ? size : "1024x1024";
    const [width, height] = outputSize.split("x").map(Number);
    const safeTool = typeof tool === "string" ? tool.slice(0, 60) : "Edit foto";
    const lightingPresets = { natural: "gunakan cahaya alami lembut dan seimbang", softbox: "gunakan pencahayaan softbox studio profesional yang lembut dan terarah", golden: "gunakan cahaya golden hour hangat", dramatic: "gunakan pencahayaan studio dramatis dengan bayangan terkontrol", clean: "gunakan pencahayaan komersial bersih, terang, dan merata" };
    const lightingInstruction = lightingPresets[lighting] || lightingPresets.softbox;
    const lockInstructions = [faceLock ? "ATURAN WAJAH PALING UTAMA: foto input adalah satu-satunya sumber identitas. Pertahankan orang yang sama persis dan jangan menciptakan ulang atau menafsirkan ulang wajah. Pertahankan geometri wajah dan proporsi kepala, jarak dan bentuk mata, alis, hidung, bibir, pipi, rahang, dagu, telinga, garis rambut, warna kulit, usia tampak, ekspresi, arah pandang, dan sudut kepala sesuai foto asli. Pertahankan hijab, riasan, aksesori, serta detail wajah yang terlihat. DILARANG mengubah bentuk wajah, membuat wajah lebih cantik/tirus, mengganti ekspresi, mengubah usia, menghaluskan kulit berlebihan, mengubah makeup, atau mengubah identitas. Jika instruksi edit bertentangan dengan kemiripan wajah, utamakan mempertahankan wajah dan abaikan perubahan pada wajah. Lakukan perubahan hanya pada area non-wajah sejauh memungkinkan." : "", productLock ? "Prioritaskan konsistensi produk: pertahankan bentuk, proporsi, warna, label, logo, material, dan detail produk sesuai foto referensi; jangan mendesain ulang produk." : ""].filter(Boolean).join(" ");
    const retouchInstructions = {
      natural: "Lakukan retouch natural: pertahankan tekstur pori kulit, garis ekspresi, dan detail alami. Hilangkan hanya noda sementara yang mengganggu; hindari efek kulit plastik.",
      studio: "Lakukan retouch studio profesional: rapikan pencahayaan, white balance, dan ketidaksempurnaan kecil secara halus; jaga tekstur dan detail asli.",
      editorial: "Lakukan retouch editorial beauty yang polished namun realistis: rapikan tone dan detail secara terukur, tanpa mengubah struktur wajah atau membuat kulit tampak seperti plastik.",
      none: "Jangan lakukan retouch kecantikan tambahan di luar instruksi utama."
    };
    const strength = Math.min(100, Math.max(0, Number(retouchStrength) || 0));
    const retouchInstruction = faceLock ? "Dengan Face Lock aktif, jangan melakukan retouch generatif pada wajah: jangan mengubah bentuk atau fitur, jangan melakukan face enhancement, beauty filter, skin smoothing, atau penggantian wajah. Pertahankan tekstur wajah asli." : (retouchInstructions[retouchProfile] || retouchInstructions.natural);
    const backgroundInstruction = backgroundMode === "keep"
      ? "Pertahankan latar belakang asli semirip mungkin; jangan mengganti lokasi atau menambahkan objek latar yang tidak diminta."
      : "Latar belakang boleh diubah sesuai instruksi prompt, tetapi pisahkan subjek dan latar secara alami.";
    const facePriority = faceLock ? "FACE PRESERVATION — PRIORITAS TERTINGGI DAN TIDAK BOLEH DIKALAHKAN OLEH INSTRUKSI LAIN: gunakan wajah pada foto input sebagai referensi identitas yang wajib dipertahankan. Jangan menggambar ulang, mempercantik, mengganti, menafsirkan ulang, atau memodifikasi wajah. Pertahankan bentuk dan geometri wajah, proporsi, mata, alis, hidung, bibir, pipi, rahang, dagu, telinga, garis rambut, warna dan tekstur kulit, usia tampak, ekspresi, arah pandang, serta riasan/hijab/aksesori persis sedekat mungkin dengan input. Jangan menerapkan beauty filter, skin smoothing, face enhancement, face swap, perubahan ekspresi, atau perubahan struktur wajah. Jangan mengubah framing, pose, atau sudut kamera. Jika edit yang diminta berisiko mengubah wajah, jangan lakukan perubahan tersebut. Utamakan edit minimal di luar area wajah." : "";
    const fullPrompt = faceLock ? `${facePriority} Permintaan edit non-wajah dari pengguna: ${prompt.trim()}. ${backgroundInstruction} Pencahayaan: ${lightingInstruction}. Pertahankan semua bagian lain dari foto semirip mungkin. Hasilkan foto realistis.` : `Tugas: ${safeTool}. Edit foto referensi sesuai instruksi: ${prompt.trim()}. Gunakan foto referensi sebagai dasar utama. ${lockInstructions} Gunakan ${lightingInstruction}. ${retouchInstruction} Intensitas retouch ${strength} dari 100; sesuaikan agar tetap natural dan tidak berlebihan. ${backgroundInstruction} Pertahankan komposisi dan ciri penting yang tidak diminta untuk diubah. Hasilkan foto realistis, detail, dan profesional.`;

    const n = Math.min(4, Math.max(1, Number.parseInt(count, 10) || 1));
    const images = await Promise.all(
      Array.from({ length: n }, () => generateOne({ accountId, token, imageBytes, prompt: fullPrompt, width, height }))
    );

    return res.status(200).json({ images, model: MODEL, provider: "Cloudflare Workers AI" });
  } catch (error) {
    const status = error.status === 401 || error.status === 403 ? 502 :
      error.status === 429 ? 429 : error.status === 413 ? 413 : 502;
    const message = error?.name === "TimeoutError"
      ? "Proses AI terlalu lama. Coba satu variasi terlebih dahulu."
      : error?.message || "Terjadi kesalahan saat menghubungi Cloudflare Workers AI.";
    return res.status(status).json({ error: message });
  }
}
