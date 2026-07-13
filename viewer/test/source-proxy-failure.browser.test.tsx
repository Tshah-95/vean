import { describe, expect, test } from "vitest";
import { page } from "vitest/browser";
import { SourceProxyFailureAlert } from "../src/components/SourceProxyFailureAlert";

describe("source proxy failure UI", () => {
  test("attributes an alpha-probe failure to the exact source", async () => {
    const sourcePath = "/project/media/overlay.mov";
    await page.render(
      <SourceProxyFailureAlert
        failure={{
          code: "ALPHA_PROBE_UNKNOWN",
          sourcePath,
          detail: "Cannot determine whether the source has alpha",
        }}
      />,
    );
    const alert = page.getByRole("alert");
    await expect.element(alert).toBeVisible();
    await expect.element(alert).toHaveAttribute("data-error-code", "ALPHA_PROBE_UNKNOWN");
    await expect.element(alert).toHaveAttribute("data-source-path", sourcePath);
    await expect.element(alert).toHaveTextContent(`ALPHA_PROBE_UNKNOWN: ${sourcePath}`);
  });
});
