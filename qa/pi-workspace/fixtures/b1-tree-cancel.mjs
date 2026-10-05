// Judge-owned Pi extension fixture for B1: cancels native tree navigation while a marker file
// exists, so the oracle can prove branch_return honours cancellation. Not a product dependency.
import { existsSync } from "node:fs";

export default function b1TreeCancelFixture(pi) {
  pi.on("session_before_tree", () => {
    const marker = process.env.PI_WORKSPACE_B1_CANCEL_MARKER;
    return marker && existsSync(marker) ? { cancel: true } : undefined;
  });
}
