// Remotion render defaults for the vean producer workspace.
//
// These defaults make even a bare `remotion studio` / `remotion render` (run by
// hand, without vean's driver) alpha-correct: PNG intermediate frames (the
// ONLY image format that can carry an alpha plane) and a yuva pixel format.
// vean's driver (src/driver/remotion.ts) ALSO passes these flags explicitly on
// every render — belt and suspenders — because the alpha plane is the load-
// bearing thing: without `--image-format=png` Remotion silently uses jpeg
// intermediates and you get a NO-alpha ProRes file that fails to composite.
import { Config } from "@remotion/cli/config";

// PNG is REQUIRED for alpha — jpeg intermediates cannot carry an alpha plane.
Config.setVideoImageFormat("png");
// Request yuva so the alpha plane survives into the encoded ProRes 4444 file.
// (ProRes 4444 is 12-bit native; the 10le request coerces to yuva444p12le — it
// still HAS an alpha plane, which is what matters.)
Config.setPixelFormat("yuva444p10le");
// ProRes 4444 is the alpha-capable codec/profile pair.
Config.setCodec("prores");
Config.setProResProfile("4444");
