import logging
from time import perf_counter

import numpy as np
import torch
from baseHandler import BaseHandler
from rich.console import Console

logger = logging.getLogger(__name__)
console = Console()

SUPPORTED_LANGUAGES = [
    "en", "fr", "de", "it", "es", "pt", "el", "nl", "pl",
    "zh", "ja", "ko", "vi", "ar",
]


class CohereTranscribeSTTHandler(BaseHandler):
    """
    Handles Speech-To-Text using CohereLabs/cohere-transcribe-03-2026.

    Architecture: Conformer encoder + Transformer decoder (~2B params).
    Language must be explicitly specified; no auto-detection is supported.
    Supports 14 languages: en, fr, de, it, es, pt, el, nl, pl, zh, ja, ko, vi, ar.
    """

    def setup(
        self,
        model_name="CohereLabs/cohere-transcribe-03-2026",
        device="cuda",
        torch_dtype="float16",
        language="en",
        punctuation=True,
        gen_kwargs={},
    ):
        if language not in SUPPORTED_LANGUAGES:
            raise ValueError(
                f"Language '{language}' is not supported by CohereTranscribe. "
                f"Choose from: {SUPPORTED_LANGUAGES}"
            )

        self.device = device
        self.torch_dtype = getattr(torch, torch_dtype)
        self.language = language
        self.punctuation = punctuation
        self.gen_kwargs = gen_kwargs

        use_device_map = device == "cuda"

        # Try the native class first (requires transformers>=5.4.0);
        # fall back to AutoModelForSpeechSeq2Seq with trust_remote_code=True.
        try:
            from transformers import CohereAsrForConditionalGeneration
            self.model = CohereAsrForConditionalGeneration.from_pretrained(
                model_name,
                device_map="auto" if use_device_map else None,
                torch_dtype=self.torch_dtype,
            )
        except (ImportError, AttributeError):
            logger.warning(
                "CohereAsrForConditionalGeneration not found in installed transformers. "
                "Falling back to AutoModelForSpeechSeq2Seq with trust_remote_code=True. "
                "Consider upgrading: pip install transformers>=5.4.0"
            )
            from transformers import AutoModelForSpeechSeq2Seq
            self.model = AutoModelForSpeechSeq2Seq.from_pretrained(
                model_name,
                device_map="auto" if use_device_map else None,
                torch_dtype=self.torch_dtype,
                trust_remote_code=True,
            )

        # device_map="auto" handles placement; only call .to() for non-CUDA devices.
        if not use_device_map:
            self.model = self.model.to(device)

        from transformers import AutoProcessor
        self.processor = AutoProcessor.from_pretrained(model_name)

        self.warmup()

    def warmup(self):
        logger.info(f"Warming up {self.__class__.__name__}")

        # 1 second of silence at 16kHz — architecture-agnostic warmup input.
        dummy_audio = np.zeros(16000, dtype=np.float32)

        try:
            inputs = self.processor(
                dummy_audio,
                sampling_rate=16000,
                return_tensors="pt",
                language=self.language,
                punctuation=self.punctuation,
            )
            inputs = inputs.to(self.model.device, dtype=self.torch_dtype)

            if self.device == "cuda":
                start_event = torch.cuda.Event(enable_timing=True)
                end_event = torch.cuda.Event(enable_timing=True)
                torch.cuda.synchronize()
                start_event.record()

            with torch.no_grad():
                _ = self.model.generate(**inputs, **self.gen_kwargs)

            if self.device == "cuda":
                end_event.record()
                torch.cuda.synchronize()
                logger.info(
                    f"{self.__class__.__name__}: warmed up! "
                    f"time: {start_event.elapsed_time(end_event) * 1e-3:.3f} s"
                )
            else:
                logger.info(f"{self.__class__.__name__}: warmed up!")

        except Exception as e:
            logger.warning(
                f"{self.__class__.__name__}: warmup failed ({type(e).__name__}: {e}). Continuing."
            )

    def process(self, spoken_prompt):
        logger.debug("Inferring CohereTranscribe...")

        global pipeline_start
        pipeline_start = perf_counter()

        if not isinstance(spoken_prompt, np.ndarray):
            spoken_prompt = np.array(spoken_prompt, dtype=np.float32)
        else:
            spoken_prompt = spoken_prompt.astype(np.float32)

        inputs = self.processor(
            spoken_prompt,
            sampling_rate=16000,
            return_tensors="pt",
            language=self.language,
            punctuation=self.punctuation,
        )
        inputs = inputs.to(self.model.device, dtype=self.torch_dtype)

        with torch.no_grad():
            output_ids = self.model.generate(**inputs, **self.gen_kwargs)

        pred_text = self.processor.decode(output_ids[0], skip_special_tokens=True).strip()

        logger.debug("Finished CohereTranscribe inference")
        console.print(f"[yellow]USER: {pred_text}")
        logger.debug(f"Language Code CohereTranscribe: {self.language}")

        yield (pred_text, self.language)

    def cleanup(self):
        if hasattr(self, "model"):
            del self.model
        if hasattr(self, "processor"):
            del self.processor
