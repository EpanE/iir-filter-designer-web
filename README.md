# IIR Speech Filter (Web)

A browser-based **IIR speech processing** tool built with the **Web Audio API**. Use cascaded biquads for HP/LP filtering, add a mains **notch** (50/60 Hz), visualize **waveform, spectrogram, magnitude & phase**, and **record** raw vs filtered audio — all client-side. Works on GitHub Pages and supports **offline/PWA**.

**Live site:** https://epane.github.io/iir-filter-designer-web

---

## Features

- **Real-time filtering** with cascaded IIR (2/4/6/8 order via biquads)
  - Modes: High-pass + Low-pass, or **Low-pass only**
  - Optional **notch** filter with adjustable **Q**
- **Visuals**: live **waveform**, **spectrogram**, **magnitude (dB)** and optional **phase**
- **Recording**: capture **raw** mic and **filtered** output separately; save as **WAV PCM16**
- **WAV rate**: keep native sample rate or resample to **16 kHz** for speech
- **Light/Dark** theme toggle (persists)
- **Help** modal with quick start + troubleshooting
- **PWA/offline**: installable, cached for offline use

---

## Quick Start

### Online (GitHub Pages)
1. Open the live site.
2. Click **Start Mic** and **allow microphone** access.
3. Put on **headphones** (prevents feedback).
4. Tweak cutoffs/orders, toggle **Apply Notch**, and watch the plots update.
5. Use **Start Recording** → **Stop Recording** → **Save Recordings** to download WAVs.

