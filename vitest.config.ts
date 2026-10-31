import { join, normalize, sep } from "node:path";
import ts from "typescript";
import { defineConfig } from "vitest/config";

const actions = join(import.meta.dirname, "src", "actions") + sep;

export default defineConfig({
	plugins: [{
		name: "typescript-action-decorators",
		enforce: "pre",
		transform(code, id) {
			if (!normalize(id).startsWith(actions) || !id.endsWith(".ts")) return;
			// Use production's TypeScript emitter for standard action decorators.
			const result = ts.transpileModule(code, {
				fileName: id,
				compilerOptions: {
					module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
					sourceMap: true, inlineSources: true
				}
			});
			return { code: result.outputText, map: result.sourceMapText };
		}
	}]
});
