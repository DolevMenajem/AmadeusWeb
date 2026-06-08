import { writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexPath = resolve(__dirname, "../../lib/api-zod/src/index.ts");

const content = `export * from "./generated/api";\n`;
writeFileSync(indexPath, content, "utf8");
console.log("Patched lib/api-zod/src/index.ts");
