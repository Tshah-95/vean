// The transcript barrel (T2/T3/T4 head). A frame-exact, stable-id transcript
// model + the seconds↔frame map + the whisper.cpp sidecar backend that fulfils
// the H3 `transcribe` job contract. Consumed by the word-level cut op
// (`src/ops/removeWords`), the transcript↔timeline query (`src/query/transcript-map`),
// and the caption-track action (`src/actions/captions`).
export {
  type Transcript,
  type TranscriptSegment,
  type TranscriptWord,
  transcriptSchema,
  transcriptSegmentSchema,
  transcriptWordSchema,
  transcriptWords,
  wordsById,
} from "./types";
export {
  type RawSegment,
  type RawWord,
  type IdMint,
  buildTranscript,
  fromJobOutput,
  framesToSeconds,
  secondsToStartFrame,
  secondsToEndFrame,
} from "./map";
export {
  type TranscribeBackend,
  BUILTIN_FIXTURE_RAW,
  TRANSCRIBE_KIND,
  resolveWhisperBin,
  resolveWhisperModel,
  toJobOutput,
  transcribeWhisper,
  whisperConfigured,
  whisperJsonToRaw,
} from "./transcribe";
