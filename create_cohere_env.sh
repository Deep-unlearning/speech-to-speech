#!/usr/bin/env bash
# Creates and configures the 's2s-cohere' conda environment for the
# speech-to-speech pipeline with CohereLabs/cohere-transcribe-03-2026.
#
# Usage: bash create_cohere_env.sh
#
# Requirements: conda installed, NVIDIA GPU with CUDA 12.x driver.

set -euo pipefail

ENV_NAME="s2s-cohere"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Creating conda environment '${ENV_NAME}' with Python 3.11"
conda create -y -n "${ENV_NAME}" python=3.11

# Activate in this script via the full path
CONDA_BASE=$(conda info --base)
source "${CONDA_BASE}/etc/profile.d/conda.sh"
conda activate "${ENV_NAME}"

echo "==> Installing PyTorch with CUDA 12.4 (compatible with CUDA 12.5 driver)"
pip install torch torchaudio torchvision \
    --index-url https://download.pytorch.org/whl/cu124

echo "==> Installing Cohere Transcribe model dependencies"
pip install \
    "transformers>=5.4.0" \
    soundfile \
    librosa \
    sentencepiece \
    protobuf \
    huggingface_hub

echo "==> Installing core pipeline dependencies"
pip install \
    "nltk==3.9.1" \
    "lingua-language-detector>=2.0.2" \
    "sounddevice>=0.5.0" \
    "websockets>=12.0" \
    rich \
    numpy \
    cancel-scope

echo "==> Installing STT backends"
pip install \
    "faster-whisper>=1.0.3" \
    "funasr>=1.1.6" \
    "modelscope>=1.17.1" \
    "nano-parakeet>=0.2.0"

echo "==> Installing TTS backends"
pip install \
    "kokoro>=0.9.2" \
    "faster-qwen3-tts>=0.2.5" \
    "pocket-tts>=0.1.0" \
    "ChatTTS>=0.1.1" \
    "openai==2.28.0"

echo "==> Installing MeloTTS from source"
pip install "melotts @ git+https://github.com/andimarafioti/MeloTTS.git"

echo "==> Installing speech-to-speech project (editable)"
pip install -e "${SCRIPT_DIR}"

echo ""
echo "Done! Activate with:"
echo "  conda activate ${ENV_NAME}"
echo ""
echo "Run with Cohere Transcribe STT:"
echo "  python s2s_pipeline.py --stt cohere-transcribe --cohere_transcribe_stt_language en"
