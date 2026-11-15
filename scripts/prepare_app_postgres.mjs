// Both database clients share the application models. Only their provider and output differ.
import { readFile, writeFile } from "node:fs/promises";

const source = await readFile(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
const schema = source.replace('provider = "prisma-client-js"', 'provider = "prisma-client-js"\n  output = "../../node_modules/@prisma/app-postgres-client"')
    .replace('provider = "sqlite"', 'provider = "postgresql"');
await writeFile(new URL("../prisma/app-postgres/schema.prisma", import.meta.url), schema);
