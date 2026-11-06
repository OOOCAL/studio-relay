// Builds the release files into dist/:
//   studio-relay-<version>.mcpb   one-click install for Claude Desktop (server + panel)
//   studio-relay-<version>.zip    manual install (install.sh / install.ps1)
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const v = pkg.version;
const dist = path.join(root, "dist");
const sh = (cmd, cwd = root) => execSync(cmd, { cwd, stdio: "inherit" });

// keep every version string in step with package.json
const manifestXml = path.join(root, "cep/com.orkun.studiorelay/CSXS/manifest.xml");
fs.writeFileSync(manifestXml, fs.readFileSync(manifestXml, "utf8")
  .replace(/ExtensionBundleVersion="[^"]+"/, `ExtensionBundleVersion="${v}"`)
  .replace(/(Extension Id="com\.orkun\.studiorelay\.panel" Version=)"[^"]+"/, `$1"${v}"`));
const mainJs = path.join(root, "cep/com.orkun.studiorelay/main.js");
fs.writeFileSync(mainJs, fs.readFileSync(mainJs, "utf8").replace(/PANEL_VERSION = "[^"]+"/, `PANEL_VERSION = "${v}"`));
const serverJs = path.join(root, "server.js");
fs.writeFileSync(serverJs, fs.readFileSync(serverJs, "utf8").replace(/export const VERSION = "[^"]+"/, `export const VERSION = "${v}"`));

fs.rmSync(dist, { recursive: true, force: true });
const stage = path.join(dist, "mcpb");
const srv = path.join(stage, "server");
fs.mkdirSync(srv, { recursive: true });
for (const f of ["server.js", "package.json", "package-lock.json"]) fs.copyFileSync(path.join(root, f), path.join(srv, f));
fs.cpSync(path.join(root, "cep"), path.join(srv, "cep"), { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(root, "mcpb/manifest.json"), "utf8"));
manifest.version = v;
fs.writeFileSync(path.join(stage, "manifest.json"), JSON.stringify(manifest, null, 2));
fs.copyFileSync(path.join(root, "LICENSE"), path.join(stage, "LICENSE"));
sh("npm ci --omit=dev --no-audit --no-fund --silent", srv);
sh(`npx -y @anthropic-ai/mcpb@2 pack "${stage}" "${path.join(dist, `studio-relay-${v}.mcpb`)}"`);

const zipDir = path.join(dist, `studio-relay-${v}`);
fs.mkdirSync(zipDir, { recursive: true });
for (const f of ["server.js", "package.json", "package-lock.json", "install.sh", "install.ps1", "uninstall.sh", "uninstall.ps1", "README.md", "LICENSE", "CHANGELOG.md"])
  fs.copyFileSync(path.join(root, f), path.join(zipDir, f));
fs.cpSync(path.join(root, "cep"), path.join(zipDir, "cep"), { recursive: true });
sh(`zip -qr "studio-relay-${v}.zip" "studio-relay-${v}"`, dist);
fs.rmSync(zipDir, { recursive: true, force: true });
fs.rmSync(stage, { recursive: true, force: true });
console.log(`\nbuilt dist/studio-relay-${v}.mcpb and dist/studio-relay-${v}.zip`);
