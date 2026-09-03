// /api/eduai.js
// Serverless function (Vercel) — menjaga API key Gemini tetap di server,
// tidak pernah dikirim ke browser. Dipanggil oleh front-end lewat fetch('/api/eduai').

// ---- Tipe file yang AMAN dikirim sebagai inline data ke Gemini (dokumen/gambar yang
// memang didukung Gemini untuk dibaca isinya). Format Office biner (docx/pptx/xlsx/doc/
// ppt/xls) SENGAJA tidak disertakan: Gemini tidak membaca isi format-format itu secara
// andal lewat inline data, jadi daripada mengirim data yang tidak akan terbaca (atau
// berisiko bikin seluruh request gagal), file jenis itu cukup disebutkan namanya saja
// di teks konteks (lihat front-end), tanpa isinya.
const SUPPORTED_MIME_BY_EXT = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  md: 'text/markdown',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif'
};

// Batas ukuran per-file yang diunduh & dilampirkan sebagai inline data. Gemini membatasi
// total request (base64 bikin ukuran naik ~33%) sekitar 20MB, jadi kita kasih batas aman
// per file dan juga batas total gabungan di bawah.
const MAX_INLINE_FILE_BYTES = 8 * 1024 * 1024; // 8MB per file
const MAX_INLINE_TOTAL_BYTES = 15 * 1024 * 1024; // 15MB gabungan semua file dalam satu request

function guessMimeType(name, ext) {
  const cleanExt = String(ext || (name || '').split('.').pop() || '').toLowerCase().trim();
  return SUPPORTED_MIME_BY_EXT[cleanExt] || null;
}

// Unduh satu file (dari presigned URL yang dikirim front-end) dan ubah jadi bagian
// inlineData siap kirim ke Gemini. Mengembalikan null (bukan melempar error) kalau file
// tidak didukung/tidak bisa diunduh/kelewat besar — supaya satu file bermasalah tidak
// menggagalkan seluruh permintaan.
async function fetchAsInlinePart(file, remainingBudgetBytes) {
  if (!file || !file.url) return null;
  const mimeType = guessMimeType(file.name, file.ext);
  if (!mimeType) return null; // format tidak didukung untuk dibaca langsung
  if (remainingBudgetBytes <= 0) return null;

  try {
    const fileRes = await fetch(file.url);
    if (!fileRes.ok) return null;

    const contentLengthHeader = fileRes.headers.get('content-length');
    if (contentLengthHeader && Number(contentLengthHeader) > MAX_INLINE_FILE_BYTES) return null;

    const arrayBuffer = await fileRes.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_INLINE_FILE_BYTES) return null;
    if (arrayBuffer.byteLength > remainingBudgetBytes) return null;

    const base64 = Buffer.from(arrayBuffer).toString('base64');
    return {
      bytesUsed: arrayBuffer.byteLength,
      part: { inlineData: { mimeType, data: base64 } }
    };
  } catch (err) {
    console.error('Gagal mengunduh file lampiran untuk EduAI:', file.name, err);
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // PENTING: nama environment variable di Vercel HARUS tanpa spasi.
  // Jika kamu menamainya "Gemini API" di dashboard, ubah namanya menjadi GEMINI_API_KEY
  // (Vercel tidak mengizinkan spasi pada nama environment variable).
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: 'GEMINI_API_KEY belum diset di Environment Variables Vercel. Tambahkan di Project Settings > Environment Variables, lalu redeploy.'
    });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const { message, senderName, history, files } = body || {};

  if (!message || typeof message !== 'string' || !message.trim()) {
    res.status(400).json({ error: 'Pesan kosong.' });
    return;
  }

  const safeSenderName = (senderName && String(senderName).trim()) || 'Pengguna';
  // Batas dinaikkan dari 4000 -> 12000 karena "message" sekarang juga bisa memuat isi
  // materi/pengumuman yang dilampirkan (teksnya), bukan cuma pertanyaan singkat.
  const promptText = `${safeSenderName}: ${message.slice(0, 12000)}`;

  // Riwayat dari front-end sudah difilter: hanya pesan sejak sesi EduAI aktif saat ini
  // dimulai, yang mengandung "@EduAI" beserta jawaban EduAI-nya (nama pengirim sudah ada
  // di dalam teksnya). Batasi jumlah pesan yang diteruskan ke Gemini agar payload wajar.
  const trimmedHistory = Array.isArray(history) ? history.slice(-40) : [];

  // ---- Lampirkan isi file materi (kalau ada & didukung) sebagai inline data, supaya
  // Gemini benar-benar MEMBACA isinya — bukan cuma menerima link URL sebagai teks. ----
  const fileList = Array.isArray(files) ? files.slice(0, 10) : [];
  const fileParts = [];
  const skippedFileNames = [];
  let usedBytes = 0;
  for (const f of fileList) {
    const remaining = MAX_INLINE_TOTAL_BYTES - usedBytes;
    const result = await fetchAsInlinePart(f, remaining);
    if (result) {
      fileParts.push(result.part);
      usedBytes += result.bytesUsed;
    } else {
      skippedFileNames.push((f && f.name) || 'file');
    }
  }

  const lastTurnParts = [{ text: promptText }, ...fileParts];
  if (skippedFileNames.length > 0) {
    lastTurnParts.push({
      text: `[Catatan sistem: file berikut TIDAK bisa dibaca langsung oleh AI (format tidak didukung, ` +
            `gagal diunduh, atau ukurannya terlalu besar) — jika relevan, sampaikan ke pengguna untuk ` +
            `mengunggah ulang sebagai PDF/gambar/teks: ${skippedFileNames.join(', ')}]`
    });
  }

  const contents = [
    ...trimmedHistory.map(h => ({
      role: h.role === 'ai' ? 'model' : 'user',
      parts: [{ text: String(h.text || '').slice(0, 2000) }]
    })),
    { role: 'user', parts: lastTurnParts }
  ];

  const systemInstruction = {
    parts: [{
      text: 'You are EduAI, a friendly and concise learning assistant embedded inside the EduClass classroom app. ' +
            'Each user message is prefixed with "Name: " to indicate who is asking — use that name to address them ' +
            'personally when it feels natural, but never repeat that "Name: " prefix format in your own reply. ' +
            'When study material or attached files are provided, treat them as your primary source of truth before ' +
            'relying on general knowledge, and clearly say so if a file could not be read. ' +
            'Always reply in the same language the user used in their most recent message — not necessarily the ' +
            'language of earlier messages in the conversation. ' +
            'Help explain lessons, answer questions, and give example problems or exercises when asked. Keep answers ' +
            'clear, warm, and appropriately concise for both students and teachers.'
    }]
  };

  // Bisa dioverride lewat env var GEMINI_MODEL jika perlu ganti model tanpa ubah kode.
  const model = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';

  try {
    // Pakai endpoint streamGenerateContent (bukan generateContent) supaya jawaban Gemini
    // datang bertahap per potongan teks, bukan menunggu selesai total baru dikirim sekaligus.
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
          contents,
          systemInstruction,
          generationConfig: { temperature: 0.7, maxOutputTokens: 1024 }
        })
      }
    );

    // Kalau Gemini langsung menolak (mis. API key salah, model tidak ada), header responsnya
    // sudah cukup untuk tahu itu di sini — SEBELUM kita mulai menulis stream ke client — jadi
    // kita masih bisa balas error terstruktur seperti biasa (bukan sebagai potongan teks).
    if (!geminiRes.ok) {
      const data = await geminiRes.json().catch(() => ({}));
      console.error('Gemini API error:', data);
      res.status(geminiRes.status).json({
        error: (data && data.error && data.error.message) || 'Gagal menghubungi Gemini API.'
      });
      return;
    }

    // Mulai stream ke client: setiap event SSE dari Gemini (format "data: {...}") berisi
    // POTONGAN teks baru (bukan teks kumulatif), jadi cukup diteruskan apa adanya sebagai
    // teks polos — front-end tinggal menempelkannya berurutan.
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no' // matikan buffering di reverse proxy (mis. Nginx) supaya benar-benar streaming
    });

    const reader = geminiRes.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });

      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop(); // baris terakhir mungkin belum lengkap, simpan untuk potongan berikutnya

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const jsonStr = trimmed.slice(5).trim();
        if (!jsonStr || jsonStr === '[DONE]') continue;
        try {
          const parsed = JSON.parse(jsonStr);
          const delta = parsed?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
          if (delta) res.write(delta);
        } catch (e) {
          // Baris SSE yang belum lengkap/tidak valid — lewati saja, akan tergabung di potongan berikutnya.
        }
      }
    }

    res.end();
  } catch (err) {
    console.error('EduAI handler error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Terjadi kesalahan saat menghubungi EduAI.' });
    } else {
      res.end();
    }
  }
}
