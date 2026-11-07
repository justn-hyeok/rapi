/**
 * What the owner says they care about, as facets of a repository: its language,
 * field, size, activity, form, age, maker, license and topics. Each facet value
 * is a key such as "분야:터미널·TUI", and an interest gives it a weight from -1
 * (not for me) to 1 (show me these).
 */

/** What is known about a repository, from a star or a search. */
export interface RepoFacts {
  fullName: string;
  description: string;
  language: string | null;
  stars: number;
  topics?: readonly string[];
  pushedAt?: Date | string | null;
  createdAt?: Date | string | null;
  ownerType?: string | null;
  license?: string | null;
}

export type FacetGroup =
  | "언어"
  | "분야"
  | "규모"
  | "활동"
  | "형태"
  | "나이"
  | "만든 쪽"
  | "만든 곳"
  | "라이선스"
  | "topic";

export const FACET_GROUPS: readonly FacetGroup[] = [
  "분야",
  "언어",
  "형태",
  "규모",
  "활동",
  "나이",
  "만든 쪽",
  "만든 곳",
  "라이선스",
  "topic",
];

interface Field {
  name: string;
  match: RegExp;
  // GitHub topics a search for new repositories in this field uses.
  search: readonly string[];
}

// Matched against topics, the repository's name and its description together.
// Narrow fields first: a repository can sit in several.
export const FIELDS: readonly Field[] = [
  {
    name: "Claude Code 확장·플러그인",
    match:
      /claude[- ]code[- ](?:plugin|skill|hook|extension|config|statusline|agent)|claude[- ]skills|\bhooks?\b.*claude|claude.*\bhooks?\b|statusline|slash[- ]command/i,
    search: ["claude-code-plugin", "claude-skills"],
  },
  {
    name: "코딩 에이전트",
    match:
      /coding[- ]agent|ai[- ]coding|agentic[- ]coding|claude[- ]code|\bcodex\b|opencode|cursor|copilot|aider|code[- ]assistant|gemini[- ]cli|antigravity|코딩 에이전트/i,
    search: ["coding-agent", "claude-code", "ai-coding"],
  },
  {
    name: "에이전트 오케스트레이션·멀티 에이전트",
    match:
      /orchestrat|multi[- ]agent|swarm|subagent|parallel agents|agent teams?|worktree|오케스트레이션/i,
    search: ["agent-orchestration", "multi-agent"],
  },
  {
    name: "AI 에이전트 일반",
    match:
      /\bagents?\b|agentic|autonomous|crewai|langgraph|openclaw|hermes[- ]agent|에이전트/i,
    search: ["ai-agents", "agent"],
  },
  {
    name: "에이전트 스킬·프롬프트",
    match:
      /\bskills?\b|prompt|system[- ]prompt|claude\.md|agents\.md|cursor[- ]?rules|스킬|프롬프트/i,
    search: ["agent-skills", "prompt-engineering"],
  },
  {
    name: "에이전트 메모리·컨텍스트",
    match:
      /memory|context[- ]engineering|context window|long[- ]term|knowledge graph|session (?:history|log)|기억|컨텍스트/i,
    search: ["agent-memory", "context-engineering"],
  },
  {
    name: "컴퓨터 사용·브라우저 에이전트",
    match:
      /computer[- ]use|browser[- ]use|browser agent|desktop automation|gui agent|operator/i,
    search: ["computer-use", "browser-use"],
  },
  {
    name: "명세·계획 주도 개발",
    match:
      /spec[- ]driven|specification|\bspecs?\b|planning|\bplan mode\b|requirements|\bprd\b|기획|명세/i,
    search: ["spec-driven-development"],
  },
  {
    name: "코드 리뷰·감사",
    match:
      /code[- ]review|reviewer|\baudit|pull request review|\bpr review|리뷰/i,
    search: ["code-review", "ai-code-review"],
  },
  {
    name: "바이브 코딩·앱 생성",
    match:
      /vibe[- ]coding|app builder|no[- ]code|low[- ]code|generate (?:apps?|websites?)|lovable|bolt\.new|v0\b/i,
    search: ["vibe-coding", "app-builder"],
  },
  {
    name: "AI 사용량·비용",
    match: /usage|token count|cost|quota|rate limit|billing|spend|사용량|토큰/i,
    search: ["token-usage", "llm-cost"],
  },
  {
    name: "LLM 게이트웨이·프록시",
    match:
      /gateway|router|openai[- ]compatible|api proxy|relay|one[- ]api|new[- ]api|litellm|openrouter|중계/i,
    search: ["llm-gateway", "openai-proxy"],
  },
  {
    name: "MCP",
    match: /\bmcp\b|model[- ]context[- ]protocol/i,
    search: ["mcp", "mcp-server"],
  },
  {
    name: "LLM 앱·RAG",
    match:
      /\brag\b|retrieval|langchain|llamaindex|vector|embedding|chatbot|chat ui|semantic search|text[- ]to[- ]sql/i,
    search: ["rag", "llm-app"],
  },
  {
    name: "LLM API·SDK",
    match:
      /\bsdk\b.*(?:llm|openai|anthropic|claude|gemini)|(?:openai|anthropic|claude|gemini) (?:api|sdk)|ai sdk/i,
    search: ["ai-sdk", "llm"],
  },
  {
    name: "오픈 모델",
    match:
      /deepseek|qwen|llama\b|mistral|gemma|kimi|glm|open[- ]weights?|open[- ]source model/i,
    search: ["open-source-llm", "deepseek", "qwen"],
  },
  {
    name: "로컬 LLM·추론",
    match:
      /ollama|llama\.cpp|gguf|vllm|inference|quantiz|local[- ]llm|on[- ]device|mlx|onnx/i,
    search: ["local-llm", "llm-inference", "ollama"],
  },
  {
    name: "모델 학습·연구",
    match:
      /training|fine[- ]?tun|lora|pytorch|transformer|deep[- ]learning|machine[- ]learning|neural|paper|research|benchmark|eval(?:uation)?s?\b|大模型/i,
    search: ["deep-learning", "fine-tuning", "llm-evaluation"],
  },
  {
    name: "이미지·영상 생성",
    match:
      /stable[- ]diffusion|comfyui|image[- ]generation|text[- ]to[- ]image|video[- ]generat|\bsora\b|midjourney|upscal|nano[- ]banana/i,
    search: ["stable-diffusion", "image-generation", "video-generation"],
  },
  {
    name: "음성·TTS·STT",
    match:
      /\btts\b|text[- ]to[- ]speech|speech|whisper|voice|\basr\b|audio|음성/i,
    search: ["text-to-speech", "speech-recognition", "voice"],
  },
  {
    name: "터미널·TUI",
    match:
      /terminal|\btui\b|tmux|zellij|ratatui|bubbletea|emulator|ghostty|herdr|터미널/i,
    search: ["tui", "terminal"],
  },
  {
    name: "CLI 도구",
    match: /\bcli\b|command[- ]line|cmd tool/i,
    search: ["cli", "command-line-tool"],
  },
  {
    name: "셸·dotfiles",
    match: /\bshell\b|\bzsh\b|\bbash\b|\bfish\b|dotfiles|prompt theme/i,
    search: ["dotfiles", "zsh", "shell"],
  },
  {
    name: "에디터·IDE",
    match:
      /editor|\bide\b|neovim|\bvim\b|vscode|vs code|\bzed\b|jetbrains|emacs|에디터/i,
    search: ["neovim", "vscode-extension", "editor"],
  },
  {
    name: "Git·버전 관리",
    match:
      /\bgit\b|github|gitlab|commit|diff\b|merge|version control|monorepo sync|copybara/i,
    search: ["git", "github-actions"],
  },
  {
    name: "macOS",
    match:
      /macos|\bmac\b|menubar|menu bar|apple silicon|raycast|hammerspoon|맥/i,
    search: ["macos", "macos-app"],
  },
  {
    name: "iOS·Swift",
    match: /\bios\b|swift|swiftui|xcode|iphone|ipad/i,
    search: ["swiftui", "ios"],
  },
  {
    name: "Android",
    match: /android|kotlin|jetpack/i,
    search: ["android", "jetpack-compose"],
  },
  {
    name: "크로스플랫폼 모바일",
    match: /flutter|react[- ]native|\bexpo\b|\bdart\b/i,
    search: ["flutter", "react-native"],
  },
  {
    name: "데스크톱 앱",
    match: /desktop|electron|tauri|\bgui\b|windows app|wallpaper|월페이퍼/i,
    search: ["tauri", "electron", "desktop-app"],
  },
  {
    name: "브라우저 확장",
    match:
      /chrome extension|browser extension|firefox add-?on|userscript|크롬 익스텐션|확장 프로그램/i,
    search: ["chrome-extension", "browser-extension"],
  },
  {
    name: "웹 프론트엔드",
    match:
      /frontend|front-end|react|next\.?js|\bvue\b|svelte|solid|angular|vite|\bspa\b|tailwind|\bcss\b|프론트|웹사이트|client/i,
    search: ["react", "nextjs", "frontend"],
  },
  {
    name: "UI 컴포넌트·디자인",
    match:
      /\bui\b|component|design[- ]system|shadcn|figma|icons?\b|theme|피그마|디자인/i,
    search: ["ui-components", "design-system"],
  },
  {
    name: "텍스트·타이포그래피",
    match:
      /\btext (?:layout|measurement|rendering)|typograph|\bfonts?\b|글꼴|폰트/i,
    search: ["typography", "fonts"],
  },
  {
    name: "애니메이션·그래픽스",
    match:
      /animation|motion|canvas|webgl|three\.?js|shader|graphics|\bsvg\b|render/i,
    search: ["animation", "webgl", "threejs"],
  },
  {
    name: "백엔드·API",
    match:
      /backend|back-end|\bapi\b|server|rest\b|graphql|grpc|express|fastapi|django|spring|nestjs|hono|백엔드|서버/i,
    search: ["backend", "api", "web-framework"],
  },
  {
    name: "아키텍처·설계",
    match:
      /architecture|domain[- ]driven|\bddd\b|domain event|clean code|object[- ]oriented|design pattern|객체지향|아키텍처|설계/i,
    search: ["software-architecture", "domain-driven-design"],
  },
  {
    name: "데이터베이스",
    match:
      /database|\bsql\b|postgres|mysql|sqlite|redis|mongo|\borm\b|drizzle|prisma|supabase|duckdb|데이터베이스/i,
    search: ["database", "postgresql", "orm"],
  },
  {
    name: "인프라·DevOps",
    match:
      /devops|deploy|ci\/cd|\bci\b|github[- ]actions|terraform|ansible|infra|monitoring|observability|logging|self[- ]host|배포/i,
    search: ["devops", "self-hosted", "observability"],
  },
  {
    name: "컨테이너·쿠버네티스",
    match: /docker|container|kubernetes|\bk8s\b|helm|podman|sandbox/i,
    search: ["kubernetes", "docker"],
  },
  {
    name: "클라우드·서버리스",
    match: /cloud|serverless|\baws\b|vercel|cloudflare|lambda|\bedge\b/i,
    search: ["serverless", "cloudflare-workers"],
  },
  {
    name: "네트워크·프록시",
    match:
      /proxy|network|\bvpn\b|tunnel|\bdns\b|http client|websocket|p2p|socks|네트워크/i,
    search: ["proxy", "networking"],
  },
  {
    name: "보안",
    match:
      /security|pentest|vulnerab|exploit|\bctf\b|malware|reverse[- ]engineer|crypto(?!currency)|\bauth|password|보안/i,
    search: ["security", "pentesting"],
  },
  {
    name: "웹 스크래핑·브라우저 자동화",
    match:
      /scrap|crawl|playwright|puppeteer|selenium|browser[- ]automation|headless|크롤/i,
    search: ["web-scraping", "browser-automation"],
  },
  {
    name: "테스트·품질",
    match:
      /\btest|testing|\be2e\b|lint|eslint|formatter|type[- ]check|\bqa\b|테스트/i,
    search: ["testing", "linter"],
  },
  {
    name: "빌드·패키지·모노레포",
    match:
      /bundler|build tool|webpack|esbuild|rollup|turbo|monorepo|package manager|\bnpm\b|pnpm|\bbun\b|cargo/i,
    search: ["build-tool", "monorepo", "bundler"],
  },
  {
    name: "유틸리티 라이브러리",
    match: /utility|utilities|lodash|toolkit|helpers?\b|es-toolkit|유틸/i,
    search: ["utility-library", "utilities"],
  },
  {
    name: "프로그래밍 언어·컴파일러",
    match:
      /compiler|interpreter|language implementation|parser|\bast\b|\bvm\b|wasm|webassembly|type system|functional programming|elm\b/i,
    search: ["compiler", "programming-language", "webassembly"],
  },
  {
    name: "운영체제·시스템",
    match:
      /kernel|operating system|\bos\b|linux|embedded|firmware|driver|low[- ]level|systems programming/i,
    search: ["operating-system", "linux", "embedded"],
  },
  {
    name: "하드웨어·IoT",
    match: /hardware|arduino|raspberry|esp32|\biot\b|robot|keyboard|3d print/i,
    search: ["arduino", "iot", "robotics"],
  },
  {
    name: "게임",
    match:
      /\bgames?\b|unity|unreal|godot|bevy|emulat|minecraft|gamedev|nikke|게임/i,
    search: ["gamedev", "game-engine"],
  },
  {
    name: "애니·서브컬처",
    match: /anime|manga|otaku|vtuber|waifu|live2d|spine|오타쿠|애니|일코/i,
    search: ["anime", "live2d"],
  },
  {
    name: "데이터·시각화",
    match:
      /data[- ]science|analytics|visuali[sz]|chart|dashboard|pandas|jupyter|notebook|\betl\b|spreadsheet|mind ?map|markmap|시각화/i,
    search: ["data-visualization", "data-science"],
  },
  {
    name: "금융·트레이딩",
    match: /trading|finance|stock|bitcoin|quant|portfolio|backtest|투자|주식/i,
    search: ["trading", "quantitative-finance"],
  },
  {
    name: "블록체인",
    match: /blockchain|ethereum|solidity|web3|smart contract|cryptocurrency/i,
    search: ["blockchain", "web3"],
  },
  {
    name: "노트·지식 관리",
    match:
      /obsidian|notion|\bnotes?\b|knowledge|wiki|markdown|zettelkasten|\bpkm\b|second brain|노트/i,
    search: ["obsidian", "knowledge-management", "note-taking"],
  },
  {
    name: "생산성·자동화",
    match:
      /productivity|automation|workflow|\bn8n\b|zapier|launcher|clipboard|자동화|생산성/i,
    search: ["productivity", "automation"],
  },
  {
    name: "문서·사이트 생성",
    match:
      /documentation|static site|\bblog\b|\bdocs\b|\bmdx\b|astro|hugo|docusaurus|문서|블로그/i,
    search: ["static-site-generator", "documentation"],
  },
  {
    name: "협업·커뮤니케이션",
    match: /communication|collaborat|team chat|hive mind|messag|협업|소통/i,
    search: ["collaboration", "team-communication"],
  },
  {
    name: "디스코드·봇·메신저",
    match: /discord|slack|telegram|\bbot\b|kakao|chat app|디스코드|봇/i,
    search: ["discord-bot", "telegram-bot"],
  },
  {
    name: "영상·미디어",
    match: /video|ffmpeg|stream|youtube|media|subtitle|music|player|영상/i,
    search: ["ffmpeg", "video", "streaming"],
  },
  {
    name: "번역·다국어",
    match: /translat|i18n|l10n|localization|multilingual|번역/i,
    search: ["translation", "i18n"],
  },
  {
    name: "소셜·페르소나 AI",
    match:
      /persona|social (?:ai|agent|mind)|companion|character ai|roleplay|페르소나/i,
    search: ["ai-companion", "persona"],
  },
  {
    name: "한국어·한국 개발",
    match:
      /korean|hangul|\p{Script=Hangul}|kakao|naver|toss|velog|woowa|우아한/iu,
    search: ["korean", "hangul"],
  },
  {
    name: "중국어권 자료",
    match: /\p{Script=Han}{2,}|chinese/iu,
    search: ["chinese"],
  },
  {
    name: "면접·학습 자료",
    match:
      /interview|tutorial|course|\blearn|roadmap|\bbook\b|cheat ?sheet|study|lecture|\bguide\b|resume|hiring|example|면접|이력서|취업|이직|교육|튜토리얼|예제|教程/i,
    search: ["interview", "learning-resources"],
  },
  {
    name: "학교·동아리 프로젝트",
    match: /bssm|school|club|student|hackathon|동아리|학교|해커톤|외주/i,
    search: ["hackathon"],
  },
];

// What the repository is, rather than what it is about. The first match wins.
const FORMS: ReadonlyArray<{ name: string; match: RegExp }> = [
  {
    name: "목록·자료 모음",
    match: /\bawesome\b|curated|list of|collection|resources/i,
  },
  {
    name: "학습·튜토리얼",
    match: /tutorial|course|learn|roadmap|interview|book|example|study/i,
  },
  { name: "MCP 서버", match: /mcp[- ]server|\bmcp\b/i },
  {
    name: "플러그인·확장",
    match: /plugin|extension|addon|add-on|integration/i,
  },
  {
    name: "템플릿·스타터",
    match: /template|starter|boilerplate|scaffold|kit\b/i,
  },
  { name: "설정·dotfiles", match: /dotfiles|config|settings|setup/i },
  { name: "CLI 도구", match: /\bcli\b|command[- ]line/i },
  {
    name: "라이브러리·프레임워크",
    match: /library|framework|\bsdk\b|\bapi\b|package|toolkit|engine/i,
  },
  {
    name: "앱·서비스",
    match: /\bapp\b|application|desktop|self[- ]host|platform|dashboard/i,
  },
];

const SIZES: ReadonlyArray<[number, string]> = [
  [100, "★100 미만 (숨은 것)"],
  [1_000, "★100–1천"],
  [10_000, "★1천–1만"],
  [50_000, "★1만–5만"],
  [Infinity, "★5만 이상 (유명한 것)"],
];

const DAY_MS = 86_400_000;
const asTime = (value: Date | string | null | undefined) =>
  value ? new Date(value).getTime() : NaN;

const text = (repo: RepoFacts) =>
  [
    repo.fullName.split("/")[1]?.replace(/[-_.]/g, " ") ?? "",
    repo.description,
    ...(repo.topics ?? []).map((topic) => topic.replace(/-/g, " ")),
  ].join(" ");

/** Every facet key a repository has, such as "언어:Rust" or "규모:★1천–1만". */
export function repoFacets(repo: RepoFacts, now: Date): string[] {
  const about = text(repo);
  const keys: string[] = [];
  if (repo.language) keys.push(`언어:${repo.language}`);
  for (const field of FIELDS)
    if (field.match.test(about)) keys.push(`분야:${field.name}`);
  const form = FORMS.find((candidate) => candidate.match.test(about));
  if (form) keys.push(`형태:${form.name}`);
  keys.push(`규모:${SIZES.find(([below]) => repo.stars < below)![1]}`);
  const pushed = now.getTime() - asTime(repo.pushedAt);
  if (Number.isFinite(pushed))
    keys.push(
      `활동:${
        pushed < 30 * DAY_MS
          ? "이번 달에도 고침"
          : pushed < 365 * DAY_MS
            ? "올해 고침"
            : "1년 넘게 멈춤"
      }`,
    );
  const age = now.getTime() - asTime(repo.createdAt);
  if (Number.isFinite(age))
    keys.push(
      `나이:${
        age < 365 * DAY_MS
          ? "1년 안 된 새것"
          : age < 3 * 365 * DAY_MS
            ? "1–3년"
            : "3년 넘은 것"
      }`,
    );
  if (repo.ownerType)
    keys.push(
      `만든 쪽:${repo.ownerType === "Organization" ? "회사·단체" : "개인"}`,
    );
  if (repo.license !== undefined)
    keys.push(
      `라이선스:${
        !repo.license || repo.license === "NOASSERTION"
          ? "라이선스 없음·기타"
          : /^(?:A|L)?GPL|MPL|EUPL/i.test(repo.license)
            ? "GPL 계열 (공개 의무)"
            : "MIT·Apache 등 허용적"
      }`,
    );
  const owner = repo.fullName.split("/")[0];
  if (owner) keys.push(`만든 곳:${owner}`);
  for (const topic of repo.topics ?? []) keys.push(`topic:${topic}`);
  return keys;
}

export const facetGroup = (key: string) =>
  key.slice(0, key.indexOf(":")) as FacetGroup;
export const facetValue = (key: string) => key.slice(key.indexOf(":") + 1);

/** The facet keys the page offers, with how many stars have each and a few examples. */
export function facetCatalog(
  repos: readonly RepoFacts[],
  now: Date,
): Array<{ key: string; count: number; examples: string[] }> {
  const byKey = new Map<string, { count: number; examples: RepoFacts[] }>();
  for (const repo of repos)
    for (const key of repoFacets(repo, now)) {
      const entry = byKey.get(key) ?? { count: 0, examples: [] };
      entry.count += 1;
      entry.examples.push(repo);
      byKey.set(key, entry);
    }
  return (
    [...byKey]
      // A topic or maker on one star is noise next to sixty fields.
      .filter(
        ([key, entry]) =>
          !["topic", "만든 곳"].includes(facetGroup(key)) || entry.count >= 2,
      )
      .sort(
        ([a, x], [b, y]) =>
          FACET_GROUPS.indexOf(facetGroup(a)) -
            FACET_GROUPS.indexOf(facetGroup(b)) ||
          y.count - x.count ||
          a.localeCompare(b),
      )
      .map(([key, entry]) => ({
        key,
        count: entry.count,
        examples: [...entry.examples]
          .sort((a, b) => b.stars - a.stars)
          .slice(0, 4)
          .map((repo) => repo.fullName),
      }))
  );
}

export type Interests = Readonly<Record<string, number>>;

// A thumb on one card moves its facets this much, so one vote never outweighs
// what the owner picked on the page.
export const VOTE_WEIGHT = 0.25;

/** The page's choices plus every vote, each facet clamped to -1..1. */
export function combinedInterests(
  picked: Interests,
  votes: ReadonlyArray<{ vote: number; facets: readonly string[] }>,
): Interests {
  const weights: Record<string, number> = { ...picked };
  for (const { vote, facets } of votes)
    for (const key of facets)
      weights[key] = (weights[key] ?? 0) + vote * VOTE_WEIGHT;
  for (const key of Object.keys(weights))
    weights[key] = Math.max(-1, Math.min(1, weights[key]!));
  return weights;
}

/**
 * How well a repository fits, and the liked facets it has. Fields and topics
 * say what it is about, so they count most; any disliked facet pulls it down.
 */
export function interestFit(
  repo: RepoFacts,
  interests: Interests,
  now: Date,
): { score: number; liked: string[] } {
  let score = 0;
  const liked: string[] = [];
  for (const key of repoFacets(repo, now)) {
    const weight = interests[key] ?? 0;
    if (weight === 0) continue;
    const group = facetGroup(key);
    const scale = group === "분야" || group === "topic" ? 2 : 1;
    score += weight * scale;
    if (weight > 0) liked.push(key);
  }
  return { score, liked };
}

/** Whether a repository is about anything the owner likes, not only its size or license. */
export const aboutLiked = (liked: readonly string[]) =>
  liked.some((key) =>
    ["분야", "topic", "언어", "형태"].includes(facetGroup(key)),
  );

/** "터미널·TUI · Rust · ★1천–1만": the liked facets, most telling first. */
export function interestReason(liked: readonly string[]): string {
  return [...liked]
    .sort(
      (a, b) =>
        FACET_GROUPS.indexOf(facetGroup(a)) -
        FACET_GROUPS.indexOf(facetGroup(b)),
    )
    .slice(0, 4)
    .map((key) =>
      facetGroup(key) === "topic" ? `#${facetValue(key)}` : facetValue(key),
    )
    .join(" · ");
}

/** The search queries for new repositories: liked fields, in the liked languages and sizes. */
export function interestQueries(
  interests: Interests,
  now: Date,
  count = 3,
): string[] {
  const liked = (group: FacetGroup) =>
    Object.entries(interests)
      .filter(([key, weight]) => facetGroup(key) === group && weight > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([key]) => facetValue(key));
  const topics = [
    ...liked("topic"),
    ...liked("분야").flatMap(
      (name) => FIELDS.find((field) => field.name === name)?.search[0] ?? [],
    ),
  ];
  const languages = liked("언어");
  const sizes = liked("규모");
  const range = sizes.length
    ? (() => {
        const bounds = sizes.map((size) => {
          const index = SIZES.findIndex(([, name]) => name === size);
          return [index === 0 ? 10 : SIZES[index - 1]![0], SIZES[index]![0]];
        });
        const low = Math.min(...bounds.map(([low]) => low!));
        const high = Math.max(...bounds.map(([, high]) => high!));
        return high === Infinity ? `>=${low}` : `${low}..${high}`;
      })()
    : "50..50000";
  const pushed = new Date(now.getTime() - 90 * DAY_MS)
    .toISOString()
    .slice(0, 10);
  return [...new Set(topics)]
    .slice(0, count)
    .map((topic, index) =>
      [
        `topic:${topic}`,
        languages.length
          ? `language:"${languages[index % languages.length]}"`
          : "",
        `stars:${range}`,
        `pushed:>${pushed}`,
        "archived:false",
        "fork:false",
      ]
        .filter(Boolean)
        .join(" "),
    );
}
