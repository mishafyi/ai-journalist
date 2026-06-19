/**
 * Vitest wrapper for the offline example — proves `runPipeline` runs the full
 * discover → generate → publish flow end-to-end with a fake LLM, an inline
 * Source, and a no-op Sink (zero real services). Run via `npm test` (or
 * `npx vitest run`).
 */
import { describe, expect, it } from "vitest";
import { runBasicExample } from "./basic";

describe("examples/basic", () => {
  it("runs the pipeline end-to-end with zero real services", async () => {
    const { post, published } = await runBasicExample();

    // The pipeline returned a finished post with a title-derived slug.
    expect(post.slug).toBe("acme-widgets-ships-a-faster-widget");
    expect(post.title).toBe("Acme Widgets Ships a Faster Widget");
    expect(post.markdown).toContain("Generated offline by Example News.");
    expect(post.byline).toBe("A. Writer");

    // The no-op Sink published it (DRAFT, file-shaped URL).
    expect(published).not.toBeNull();
    expect(published?.status).toBe("DRAFT");
    expect(published?.url).toBe("out/acme-widgets-ships-a-faster-widget.md");
  });
});
