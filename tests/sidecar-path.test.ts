import { describe, expect, it } from "vitest";
import { sidecarFileName } from "../src/sidecar-path";

describe("sidecarFileName", () => {
	it("uses the .NET binary on Windows", () => {
		expect(sidecarFileName("win32")).toBe("TeamsBridge.exe");
	});

	it("uses the Swift binary on macOS", () => {
		expect(sidecarFileName("darwin")).toBe("TeamsBridge");
	});
});
