const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ── Supabase helpers (credentials passed per-request from frontend) ────────────

function makeSupabaseHelpers(supabaseUrl, supabaseKey) {
  async function getSignedUrl(storagePath, expiresIn = 3600) {
    const resp = await fetch(`${supabaseUrl}/storage/v1/object/sign/clips/${storagePath}`, {
      method: "POST",
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expiresIn }),
    });
    if (!resp.ok) throw new Error(`Failed to get signed URL for ${storagePath}: ${resp.status}`);
    const data = await resp.json();
    return `${supabaseUrl}/storage/v1${data.signedURL}`;
  }

  async function uploadToStorage(filePath, storagePath) {
    const data = fs.readFileSync(filePath);
    const resp = await fetch(`${supabaseUrl}/storage/v1/object/clips/${storagePath}`, {
      method: "POST",
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        "Content-Type": "video/mp4",
        "x-upsert": "true",
      },
      body: data,
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Storage upload failed: ${err}`);
    }
  }

  return { getSignedUrl, uploadToStorage };
}

// ── File helpers ──────────────────────────────────────────────────────────────

async function downloadToFile(url, filePath, attempt = 1) {
  const resp = await fetch(url, { redirect: "follow" });
  if (!resp.ok) {
    if (resp.status === 504 && attempt < 3) {
      await new Promise(r => setTimeout(r, attempt * 2000));
      return downloadToFile(url, filePath, attempt + 1);
    }
    throw new Error(`Download failed: HTTP ${resp.status}`);
  }
  const ct = resp.headers.get("content-type") || "";
  if (ct.includes("text/html")) throw new Error("Got HTML instead of video — check Drive sharing is set to 'Anyone with the link'.");
  const buffer = await resp.arrayBuffer();
  fs.writeFileSync(filePath, Buffer.from(buffer));
}

function extractDriveId(url) {
  const m = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  const m2 = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m2) return m2[1];
  return null;
}

// ── FFmpeg helper ─────────────────────────────────────────────────────────────

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", ["-y", ...args]);
    let stderr = "";
    proc.stderr.on("data", d => { stderr += d.toString(); });
    proc.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg error (code ${code}):\n${stderr.slice(-800)}`));
    });
    proc.on("error", err => reject(new Error(`FFmpeg not found: ${err.message}`)));
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({ ok: true, ready: true });
});

app.post("/api/stitch", async (req, res) => {
  const { clips, comboName, supabaseUrl, supabaseKey } = req.body;

  if (!clips || !clips.length) return res.status(400).json({ error: "No clips provided" });
  if (!supabaseUrl || !supabaseKey) return res.status(400).json({ error: "Missing supabaseUrl or supabaseKey in request" });

  const { getSignedUrl, uploadToStorage } = makeSupabaseHelpers(supabaseUrl, supabaseKey);

  // Set up Server-Sent Events
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const tmpDir = `/tmp/stitch_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // 1. Download clips
    const segFiles = [];
    const fromStorage = [];

    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const segPath = path.join(tmpDir, `seg_${i}.mp4`);
      send({ status: `Downloading clip ${i + 1} of ${clips.length}…` });

      if (clip.storagePath) {
        const url = await getSignedUrl(clip.storagePath);
        await downloadToFile(url, segPath);
        fromStorage.push(true);
      } else if (clip.driveUrl) {
        const fileId = extractDriveId(clip.driveUrl);
        if (!fileId) throw new Error(`Cannot parse Drive URL for clip ${clip.id}`);
        const directUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&authuser=0&confirm=t`;
        await downloadToFile(directUrl, segPath);
        fromStorage.push(false);
      } else {
        throw new Error(`No source for clip "${clip.id}" — upload to Storage or add a Drive URL.`);
      }
      segFiles.push(segPath);
    }

    // 2. Normalize non-storage clips
    const vf = "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,fps=30,format=yuv420p";
    const af = "aresample=44100,aformat=channel_layouts=mono,pan=stereo|c0=c0|c1=c0";
    const normFiles = [];

    for (let i = 0; i < segFiles.length; i++) {
      if (fromStorage[i]) {
        normFiles.push(segFiles[i]);
      } else {
        send({ status: `Normalizing clip ${i + 1} of ${segFiles.length}…` });
        const normPath = path.join(tmpDir, `norm_${i}.mp4`);
        try {
          await runFFmpeg([
            "-i", segFiles[i],
            "-vf", vf, "-c:v", "libx264", "-preset", "fast",
            "-map", "0:v:0", "-map", "0:a:0",
            "-c:a", "aac", "-ar", "44100", "-ac", "2", "-af", af,
            normPath,
          ]);
        } catch {
          await runFFmpeg([
            "-i", segFiles[i],
            "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
            "-vf", vf, "-c:v", "libx264", "-preset", "fast",
            "-map", "0:v:0", "-map", "1:a",
            "-c:a", "aac", "-ar", "44100", "-ac", "2", "-af", af,
            "-shortest", normPath,
          ]);
        }
        normFiles.push(normPath);
      }
    }

    // 3. Concat
    send({ status: "Stitching clips together…" });
    const concatList = path.join(tmpDir, "concat.txt");
    fs.writeFileSync(concatList, normFiles.map(f => `file '${f}'`).join("\n"));
    const outPath = path.join(tmpDir, "output.mp4");
    await runFFmpeg([
      "-f", "concat", "-safe", "0",
      "-i", concatList,
      "-c", "copy", "-movflags", "+faststart",
      outPath,
    ]);

    // 4. Upload result to Supabase Storage
    send({ status: "Uploading result…" });
    const safe = (comboName || "stitch").replace(/[^a-zA-Z0-9_-]/g, "_");
    const resultStoragePath = `stitched/${safe}_${Date.now()}.mp4`;
    await uploadToStorage(outPath, resultStoragePath);

    // 5. Get 24-hour signed download URL
    const downloadUrl = await getSignedUrl(resultStoragePath, 86400);
    send({ status: "done", downloadUrl, filename: safe + ".mp4" });
    res.end();

  } catch (err) {
    console.error("Stitch error:", err);
    send({ status: "error", message: err.message });
    res.end();
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AVS Stitch Server listening on port ${PORT}`));
