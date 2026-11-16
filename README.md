# Studio Relay

*(eski adı / formerly: adobe-bridge)*

Claude'un **After Effects, Premiere Pro, Photoshop, Illustrator, InDesign, Audition, Media Encoder ve Bridge**'i doğrudan yönetmesi için yerel bir MCP sunucusu. Limit yok, abonelik yok; her şey kendi bilgisayarında çalışır.

*English below.*

```
Claude (masaüstü / Code) ──stdio──> server.js ──WebSocket 127.0.0.1:8765──> "Studio Relay" paneli (her programda)
```

## Kurulum

### En kolayı: tek dosya (Claude Desktop)
1. [Releases](../../releases) sayfasından `studio-relay-x.y.z.mcpb` dosyasını indir.
2. Dosyaya çift tıkla (ya da Claude Desktop → Ayarlar → Extensions'a sürükle) ve **Install**'a bas.
3. Sunucu ilk açılışta paneli Adobe eklenti klasörüne kendisi kurar. **Adobe programlarını bir kez yeniden başlat.**
4. Programda **Window → Extensions → Studio Relay**: yeşil nokta = bağlı.

Node.js gerekmez; Claude Desktop kendi Node'unu kullanır.

### Elle kurulum (Claude Code ya da Node ile)
1. Node.js 18+ kurulu olsun: <https://nodejs.org>
2. Releases'tan `studio-relay-x.y.z.zip` indir, aç, klasörde:
   - **macOS:** `bash install.sh`
   - **Windows:** `powershell -ExecutionPolicy Bypass -File install.ps1`
3. Claude'u tamamen kapatıp aç, Adobe programlarını yeniden başlat.

Kaldırmak için: `bash uninstall.sh` / `uninstall.ps1`.

## Claude'daki araçlar

| Araç | Ne yapar |
|---|---|
| `list_apps` | Hangi programlar bağlı, hangileri başka bir program üzerinden (BridgeTalk) ulaşılabilir, bilgisayarda hangi Adobe programları kurulu |
| `app_state` | AE: kompozisyonlar ve katmanlar · Premiere: sekanslar ve klipler · PS/AI/ID: açık belgeler · Media Encoder: durum · Bridge: klasör ve seçim |
| `run_script` | Programın içinde ExtendScript çalıştırır, `return` ile sonuç döner. `launch: true` kapalı programı (Media Encoder, Bridge…) açar |
| `job_result` | Uzun süren bir işin (render, toplu dışa aktarma) sonucunu alır |
| `export_frame` | AE/Premiere'den kare, PS/AI/ID'den önizleme render edip görüntü olarak döndürür |

## Paneli olmayan programlar (Media Encoder, Bridge)

Media Encoder ve Bridge'e, paneli açık olan herhangi bir programın (önce Premiere, sonra After Effects, Photoshop…) içinden **BridgeTalk** ile ulaşılır. Bir programın kendi paneli yüklenmemişse (ör. yeni bir Illustrator/InDesign sürümü) aynı yol yedek olarak kullanılır.

Lightroom, Character Animator, XD, Dimension ve Acrobat'ın ExtendScript arayüzü yok; `list_apps` bunları nedeniyle birlikte gösterir.

## Kopmalara ve kapanmalara karşı

- **Uzun işler zaman aşımına düşmez.** Bir çağrı en fazla `wait_ms` (varsayılan 45 sn) bekler; iş sürüyorsa bir *iş numarası* döner, `job_result` sonucu sonra alır. Aynı betik yeniden çalıştırılmaz.
- **Her program için tek sıra.** Betikler sırayla çalışır; aynı anda iki kare dışa aktarma Premiere'i çökertmez.
- **Kalp atışı.** Sessizleşen bağlantı (uyuyan Mac, kapanan program) fark edilir, panel kendiliğinden yeniden bağlanır.
- **Sonuç kaybolmaz.** Bağlantı koptuğu sırada biten bir işin sonucu panelde bekler ve yeniden bağlanınca teslim edilir.
- **Birden fazla Claude penceresi.** İlk açılan sunucu "hub" olur, diğerleri ona katılır. Hub'ı açan pencere kapanırsa bir diğeri devralır.
- **Panel program açılınca kendiliğinden yüklenir**, Window menüsünden açılmamış olsa bile. Photoshop'ta panel gizlense de çalışmaya devam eder.

## Ayarlar

| Ortam değişkeni | Varsayılan | Açıklama |
|---|---|---|
| `STUDIO_RELAY_PORT` | `8765` | WebSocket portu (panelde `main.js` içindeki `PORT` da değişmeli) |
| `STUDIO_RELAY_WAIT_MS` | `45000` | Bir çağrının sonuç için beklediği süre |
| `STUDIO_RELAY_NO_PANEL_INSTALL` | – | Doluysa sunucu paneli kurmaz/güncellemez |

## Geliştirme

```
npm install
npm test          # Adobe olmadan uçtan uca test (sahte panel, iş, yeniden bağlanma, hub devri)
npm run build     # dist/ içine .mcpb ve .zip üretir
```

Yeni sürüm: `package.json` içinde sürümü artır, `CHANGELOG.md`'ye yaz, `git tag vX.Y.Z && git push --tags`. GitHub Actions testleri çalıştırır ve `.mcpb` ile `.zip`'i Release'e ekler.

## Güvenlik

Sunucu yalnızca `127.0.0.1` üzerinde dinler; ağdan erişilemez. Panel, Claude'un gönderdiği betiği programın içinde tam yetkiyle çalıştırır: dosya açabilir, silebilir, kaydedebilir. Bu yüzden yalnızca güvendiğin Claude oturumlarına bağla. Panel imzasız olduğu için kurulum Adobe'nin `PlayerDebugMode` ayarını açar.

---

## English

A local MCP server that lets Claude drive **After Effects, Premiere Pro, Photoshop, Illustrator, InDesign, Audition, Media Encoder and Bridge** through a small CEP panel in each app; apps without a loaded panel (Media Encoder, Bridge) are reached through BridgeTalk from any connected app.

**Install (Claude Desktop):** download `studio-relay-x.y.z.mcpb` from Releases, double-click it, click Install. On first start the server installs the panel into your Adobe CEP extensions folder; restart your Adobe apps once, then open **Window → Extensions → Studio Relay** (green dot = connected).

**Install (manual / Claude Code):** Node.js 18+, unzip `studio-relay-x.y.z.zip`, run `bash install.sh` (macOS) or `install.ps1` (Windows).

**Tools:** `list_apps`, `app_state`, `run_script`, `job_result`, `export_frame`.

**Reliability:** long scripts become jobs instead of timing out and are never re-run by a retry; one script per app at a time; heartbeat and automatic reconnects; results finished during a disconnect are delivered afterwards; another Claude window takes the hub over if the owner closes; the panel loads when the app starts.

**Security:** listens on `127.0.0.1` only. Scripts run with full access inside the Adobe app. The panel is unsigned, so the installer turns on Adobe's `PlayerDebugMode`.

**Build:** `npm test`, `npm run build`. Tag `vX.Y.Z` to publish a GitHub release with the `.mcpb` and `.zip` attached.

---

Bu proje Adobe ile bağlantılı değildir ve Adobe tarafından desteklenmez. Adobe, After Effects, Premiere Pro, Photoshop, Illustrator, InDesign, Audition, Media Encoder ve Bridge, Adobe Inc.'in ticari markalarıdır.
*Not affiliated with or endorsed by Adobe. Adobe product names are trademarks of Adobe Inc.*

Lisans: MIT
