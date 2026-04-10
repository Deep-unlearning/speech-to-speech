from dataclasses import dataclass, field


@dataclass
class CohereTranscribeSTTHandlerArguments:
    cohere_transcribe_stt_model_name: str = field(
        default="CohereLabs/cohere-transcribe-03-2026",
        metadata={
            "help": "The pretrained Cohere Transcribe model to use. Default is 'CohereLabs/cohere-transcribe-03-2026'."
        },
    )
    cohere_transcribe_stt_device: str = field(
        default="cuda",
        metadata={
            "help": "The device type on which the model will run. Default is 'cuda' for GPU acceleration."
        },
    )
    cohere_transcribe_stt_torch_dtype: str = field(
        default="float16",
        metadata={
            "help": "The PyTorch data type for the model. One of 'float32', 'float16', or 'bfloat16'. Default is 'float16'."
        },
    )
    cohere_transcribe_stt_language: str = field(
        default="en",
        metadata={
            "help": (
                "The language for transcription. Must be one of: "
                "en, fr, de, it, es, pt, el, nl, pl, zh, ja, ko, vi, ar. "
                "No auto-detection is supported. Default is 'en'."
            )
        },
    )
    cohere_transcribe_stt_punctuation: bool = field(
        default=True,
        metadata={
            "help": "Whether to include punctuation in the transcription output. Default is True."
        },
    )
    cohere_transcribe_stt_gen_max_new_tokens: int = field(
        default=256,
        metadata={
            "help": "The maximum number of new tokens to generate. Default is 256."
        },
    )
