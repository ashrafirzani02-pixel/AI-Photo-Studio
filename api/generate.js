export const config = {
  api: {
    bodyParser: { sizeLimit: "4mb" },
    responseLimit: false
  },
  maxDuration: 60
};

const allowedSizes = new Set(["1024x1024", "1024x1536", "1536x1024"]);

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Metode tidak diizinkan." });
  const key = process.env.OPENAI_API_KEY;
  if (!key) return res.status(503).json({ error: "OpenAI belum dikonfigurasi. Tambahkan OPENAI_API_KEY di Vercel Environment Variables." });

  try {
    const { imageBase64, prompt, size, count, tool } = req.body || {};
    if (typeof imageBase64 !== "string" || imageBase64.length < 100) return res.status(400).json({ error: "Foto tidak valid. Silakan unggah ulang." });
    if (imageBase64.length > 3_900_000) return res.status(413).json({ error: "Foto terlalu besar. Gunakan foto yang lebih kecil." });
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 1500) return res.status(400).json({ error: "Prompt wajib diisi dan maksimal 1.500 karakter." });
    const n = Math.min(4, Math.max(1, Number.parseInt(count, 10) || 1));
    const outputSize = allowedSizes.has(size) ? size : "1024x1024";
    const bytes = Buffer.from(imageBase64, "base64");
    if (bytes.length < 50 || bytes.length > 2_900_000) return res.status(413).json({ error: "Ukuran foto hasil kompresi tidak sesuai batas." });

    const safeTool = typeof tool === "string" ? tool.slice(0, 60) : "Edit foto";
    const fullPrompt = `Tugas: ${safeTool}. Edit foto referensi yang diunggah sesuai instruksi berikut: ${prompt.trim()}. Gunakan foto unggahan sebagai referensi utama. Pertahankan subjek, identitas, dan ciri penting yang tidak diminta untuk diubah. Hasilkan foto berkualitas tinggi, realistis, detail, dan siap digunakan.`;
    const form = new FormData();
    form.append("model", "gpt-image-2");
    form.append("prompt", fullPrompt);
    form.append("size", outputSize);
    form.append("quality", "medium");
    form.append("n", String(n));
    form.append("output_format", "png");
    form.append("image[]", new Blob([bytes], { type: "image/jpeg" }), "reference.jpg");

    const upstream = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(55000)
    });
    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      const message = payload?.error?.message || "Layanan OpenAI gagal memproses gambar.";
      const status = upstream.status === 401 ? 502 : upstream.status === 429 ? 429 : 502;
      return res.status(status).json({ error: message });
    }
    const images = (payload.data || []).map(item => item.b64_json).filter(Boolean);
    if (!images.length) return res.status(502).json({ error: "OpenAI tidak mengembalikan gambar. Silakan coba lagi." });
    return res.status(200).json({ images, model: "gpt-image-2" });
  } catch (error) {
    const message = error?.name === "TimeoutError" ? "Proses terlalu lama. Coba jumlah variasi lebih sedikit." : "Terjadi kesalahan server saat memproses gambar.";
    return res.status(500).json({ error: message });
  }
}