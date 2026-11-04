# Crypto news source selection · 2026-11-01

The registry adds 18 publishers/official feeds to the existing 12 sources. These
are practical selections for timeliness, original evidence, regional coverage,
and accessible text. Their trading effectiveness has not been backtested or
established by a source-level accuracy study. One usable route per publisher is
preferred over collecting identical translations and reposts on every platform.

## Added sources

| Source | Region / original language | Collection route | Main use |
| --- | --- | --- | --- |
| [Wu Blockchain](https://linktr.ee/wublockchain) | Asia / English | [Telegram](https://t.me/s/wublockchainenglish) | Regional breaking reports and exchange developments |
| [PANews](https://panews.io/rss) | Greater China / Simplified Chinese | Official RSS, newsflashes and articles | Chinese reporting and early regional context |
| [Odaily](https://github.com/ODAILY/RSS) | Greater China / Simplified Chinese | Official newsflash RSS | Chinese breaking reports and publisher evidence links |
| [Foresight News](https://paragraph.com/@foresight-news/foresight-news) | Greater China / Simplified Chinese | [Telegram](https://t.me/s/foresightnews) | Ecosystem developments and reporting leads |
| [Coinness](https://www.linkedin.com/company/coinness-official) | South Korea / Korean | [Telegram](https://t.me/s/coinnesskr) | Korean exchange, listing and regulatory news |
| [CoinPost](https://coinpost.jp/) | Japan / Japanese | Publisher RSS | Japanese market, regulation and exchange reporting |
| [BlockTempo](https://www.blocktempo.com/) | Taiwan / Traditional Chinese | Publisher RSS | Taiwan and Traditional Chinese reporting |
| [The Block](https://www.theblock.co/rss.xml) | Global / English | Public RSS | Institutional, exchange and market-structure reporting |
| [DL News](https://www.dlnews.com/) | Europe / English | Publisher RSS | Investigations and regulatory reporting |
| [CryptoQuant](https://consensus.cryptoquant.com/analyst/cryptoquant_com) | South Korea / Global / English | [Official Telegram](https://t.me/s/cryptoquant_official) | Exchange flows and market-cycle research |
| [Glassnode](https://studio.glassnode.com/privacy-notice-social-media) | Global / English | [Official X](https://x.com/glassnode) | Original on-chain and market-structure research |
| [Lookonchain](https://linktr.ee/lookonchain) | Asia / Global / English | [Official X](https://x.com/lookonchain) | Wallet movements and attributed on-chain reports |
| [PeckShieldAlert](https://peckshield.com/) | Global / English | [X](https://x.com/PeckShieldAlert) | Exploit, phishing and abnormal-flow alerts |
| [ZachXBT](https://t.me/investigations) | Global / English | Public investigations Telegram | Fraud investigations and counterparty risk |
| [Solana Status](https://status.solana.com/) | Global / English | Official incident RSS | Network incidents |
| [Coinbase Status](https://status.coinbase.com/) | US / Global / English | Official incident RSS | Exchange, withdrawal and API incidents |
| [Circle Status](https://status.circle.com/) | US / Global / English | Official incident RSS | Stablecoin infrastructure incidents |
| [Ethereum Foundation](https://blog.ethereum.org/) | Global / English | Official blog RSS | Upgrade schedules and security announcements |

## Collection and interpretation

Priority targets are one minute for Wu, PANews, Odaily, Coinness, PeckShieldAlert,
and the three incident feeds. Other additions target five minutes. Existing
Hyperliquid/Binance announcement channels and Fed policy feed remain priority
sources. Binance English discussion remains a private source on the five-minute
community schedule: setup observed substantial game/bot chatter there.

RSS runs inside the Chrome extension through credential-free HTTPS fetching and
one offscreen XML parser, without opening download tabs or activating feed HTML,
scripts, images or frames. Fetches reject redirects and have time/size limits.
Configured rolling windows are 48 hours for ordinary breaking-news feeds, seven
days for DL News/Coinbase/Circle, and 30 days for Ethereum/Solana. An accessible
incident feed with no recent incidents is healthy with no new news.

Future or unavailable RSS publication dates are excluded and reported as partial
coverage. In particular, Coinbase and Circle advertised future-dated scheduled
entries during setup. Valid past-dated entries in those feeds remain collectible;
future entries never enter current or historical model context prematurely.

Odaily's RSS host and article host differ. Only its exact registered feed URL is
authorized to reference `www.odaily.news`. Unknown feeds cannot widen their
evidence boundary through item text, links or source-management input.

Luna receives original text plus publisher/language/region/category metadata.
Summaries are English and retain original names, units and uncertainty. Source
labels are context rather than truth guarantees. Syndication and translations
remain one origin; a wallet transfer does not establish a purchase or sale. Local
listings, KRW premiums and regional restrictions need distinct interpretation.

## Reviewed limitations and alternatives

- Blockworks' legacy feed redirected to a feed whose newest item was January
  2026. The legacy X route also produced no readable captures in setup. It was
  replaced with the verified CryptoQuant channel before capturing any documents.
- Glassnode research RSS returned HTTP 403 on the VPS; use its public X research
  posts. This does not provide paid or full research reports.
- Odaily's advertised Telegram route did not expose public message previews;
  its publisher-maintained RSS worked and was selected instead.
- The existing Reddit source remains blocked by the VPS network-security gate.
  No arbitrary Discord channels, WeChat chats, private groups or DMs are added.
  Those platforms need accessible, explicitly scoped sources before collection
  can be claimed. YouTube/audio/video are not analyzed by this text pipeline.
- Initial collection and analysis catch-up can remain pending. Spot checks and
  passing tests do not establish sustained cadence on a two-core/2 GB server.
  The 24-hour observation gate applies in shadow mode. Healthy mode evaluates
  each signal against the current health of its cited sources.

## Applying the editable registry

`config/news-sources.json` records URLs, priorities, language, region, publisher,
rationale, provenance and bounded RSS policy. Runtime source rows remain editable
in Centrypto. New public sources stay wallet-scoped; public sentiment APIs do not
read this database.

Run `DOTENV_CONFIG_PATH=.env.local tsx -r dotenv/config
scripts/configure_news_sources.ts` to inspect missing entries, then append
`--apply` to add them through the paired owner's source service. Existing sources,
disabled choices and user settings are preserved; re-running is idempotent. The
live provisional Blockworks row was replaced only after verifying it was created
in this setup and contained zero documents. No historical source was overwritten.
