import { readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { fileURLToPath } from "node:url";
import { cardPayloadFor } from "@rapi/agent";
import {
  DEFAULT_CARD_TEMPLATES,
  discordEmbed,
  guildRequestCard,
  problemCard,
  releaseSummary,
  reviewCard,
  starCard,
  templateCard,
  templateText,
  useCardTemplates,
  type CandidateForCard,
  type CardTemplates,
} from "@rapi/core";
import { format } from "prettier";

// A local page for editing how Rapi's Discord messages read. It renders the real
// card functions with sample data and saves to the template file in the repo;
// the bot reads that file once a change is committed and deployed.
const TEMPLATE_FILE = fileURLToPath(
  new URL("../packages/core/src/domain/card-templates.json", import.meta.url),
);
const PAGE = fileURLToPath(new URL("./card-studio.html", import.meta.url));
const PORT = Number(process.env.CARD_STUDIO_PORT ?? "4700");

const candidate = (fields: Partial<CandidateForCard>): CandidateForCard => ({
  id: "sample",
  kind: "discount",
  route: "changelog",
  domain: "vercel.com",
  title: "GPT-6.1 Sol is 50% off on AI Gateway",
  url: "https://vercel.com/changelog/sol",
  evidence: "GPT-6.1 Sol is 50% off on AI Gateway through November 30.",
  band: "green",
  tags: [],
  operator: "Vercel",
  priceCheck: "below_list",
  termsNote: null,
  ...fields,
});

const REVIEW_BUTTONS = [
  { style: 3, label: "게시" },
  { style: 4, label: "버리기" },
];

interface Sample {
  name: string;
  note: string;
  keys: string[];
  message: () => {
    content?: string;
    embeds?: unknown[];
    buttons?: Array<{ style: number; label: string; url?: string }>;
  };
}

const linkButtons = (payload: ReturnType<typeof cardPayloadFor>) =>
  ((payload.discord?.components ?? []) as Array<{ components: unknown[] }>)
    .flatMap((row) => row.components)
    .map((button) => button as { style: number; label: string; url?: string });

const SAMPLES: Sample[] = [
  {
    name: "할인 카드 · 공식 (초록)",
    note: "게시하면 알림을 켠 서버로 나가는 카드",
    keys: [
      "출처",
      "도메인",
      "제목",
      "내용",
      "마감",
      "운영",
      "가격",
      "약관",
      "태그",
      "띠",
    ],
    message: () => {
      const payload = cardPayloadFor(
        candidate({ tags: ["#직접호스팅"] }),
        "2026-11-30",
      );
      return {
        embeds: payload.discord?.embeds as unknown[],
        buttons: linkButtons(payload),
      };
    },
  },
  {
    name: "할인 카드 · 중계 사이트 (위험)",
    note: "미검증 출처: 위험 줄과 경고 색",
    keys: ["위험", "출처", "도메인", "제목", "내용", "태그"],
    message: () => {
      const payload = cardPayloadFor(
        candidate({
          route: "relay_site",
          domain: "agentrouter.org",
          title: "AgentRouter: gpt-6.1sol 무제한, 낮은 배율로 제공",
          url: "https://agentrouter.org/",
          evidence:
            "gpt-6.1sol을 수량 제한 없이 낮은 배율로 제공합니다. 우선 사용을 권장합니다.",
          band: "yellow",
          tags: ["#재판매", "#위험"],
          operator: null,
          priceCheck: "unknown",
          termsNote: "링크 없음",
        }),
      );
      return {
        embeds: payload.discord?.embeds as unknown[],
        buttons: linkButtons(payload),
      };
    },
  },
  {
    name: "검토 카드 · 제보",
    note: "소유자 검토 채널. 메모는 검토 카드에만",
    keys: ["메모", "(할인 카드의 모든 값)"],
    message: () => ({
      embeds: [
        discordEmbed(
          reviewCard(
            candidate({
              route: "report",
              domain: "cheap-llm.test",
              title: "cheap-llm.test",
              url: "https://cheap-llm.test/pricing",
              evidence: "",
              band: "yellow",
              operator: null,
              priceCheck: "unknown",
              termsNote: "확인 못 함",
              memo: "가입하면 $10 준대요",
            }),
          ),
        ),
      ],
      buttons: REVIEW_BUTTONS,
    }),
  },
  {
    name: "문제 제보",
    note: "소유자에게만",
    keys: ["도메인", "링크", "메모", "제보자"],
    message: () => ({
      embeds: [
        discordEmbed(
          problemCard({
            id: "p",
            url: "https://scam-relay.test/",
            domain: "scam-relay.test",
            reporterId: "123456789012345678",
            memo: "충전하고 나서 키가 막혔어요",
          }),
        ),
      ],
      buttons: [
        { style: 4, label: "빨강으로 정함" },
        { style: 2, label: "문제 없음" },
      ],
    }),
  },
  {
    name: "서버 승인 요청",
    note: "소유자에게만",
    keys: ["서버", "서버ID", "요청자", "사유"],
    message: () => ({
      embeds: [
        discordEmbed(
          guildRequestCard({
            guildId: "998877665544332211",
            name: "AI 개발자 모임",
            requesterId: "123456789012345678",
            reason: "할인 알림 받고 싶어요",
          }),
        ),
      ],
    }),
  },
  {
    name: "스타 알림",
    note: "잊고 있던 GitHub 스타",
    keys: ["저장소", "설명", "언어", "별", "누른날"],
    message: () => ({
      embeds: [
        discordEmbed(
          starCard({
            fullName: "jiegec/kb",
            url: "https://github.com/jiegec/kb",
            description: "Knowledge base of jiegec",
            language: "Python",
            stars: 1234,
            archived: false,
            starredAt: new Date("2026-03-14T03:00:00Z"),
            lastRemindedAt: null,
          }),
        ),
      ],
    }),
  },
  {
    name: "라피 업데이트",
    note: "/라피-업데이트-알림 채널",
    keys: ["태그", "요약"],
    message: () => ({
      embeds: [
        discordEmbed(
          templateCard(
            "rapiUpdate",
            {
              태그: "v0.0.11-relays.4",
              요약: releaseSummary(
                "linux.do 게시판에서도 AI 혜택 글을 찾는다.\n\n## 바뀐 것\n- 하루 한 번 읽고 한국어로 옮겨 보낸다.\n\n## 확인한 것\n- 테스트 통과",
              ),
            },
            { url: "https://github.com/justn-hyeok/rapi/releases" },
          ),
        ),
      ],
    }),
  },
  {
    name: "채널 연결 테스트",
    note: "/ai-할인-알림 켜기 때 보내는 글",
    keys: ["종류"],
    message: () => ({
      content: templateText("channelTest", { 종류: "AI 할인" }),
    }),
  },
];

function render(templates: CardTemplates) {
  useCardTemplates(templates);
  try {
    return SAMPLES.map((sample) => {
      try {
        return {
          name: sample.name,
          note: sample.note,
          keys: sample.keys,
          ...sample.message(),
        };
      } catch (error) {
        return {
          name: sample.name,
          note: sample.note,
          keys: sample.keys,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
  } finally {
    useCardTemplates(DEFAULT_CARD_TEMPLATES);
  }
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return JSON.parse(body) as unknown;
}

const readTemplates = async () =>
  JSON.parse(await readFile(TEMPLATE_FILE, "utf8")) as CardTemplates;

const server = createServer(async (request, response) => {
  const send = (status: number, body: unknown, type = "application/json") => {
    response.writeHead(status, { "content-type": `${type}; charset=utf-8` });
    response.end(
      type === "application/json" ? JSON.stringify(body) : String(body),
    );
  };
  try {
    if (request.method === "GET" && request.url === "/")
      return send(200, await readFile(PAGE, "utf8"), "text/html");
    if (request.method === "GET" && request.url === "/api/templates") {
      const templates = await readTemplates();
      return send(200, { templates, samples: render(templates) });
    }
    if (request.method === "POST" && request.url === "/api/render")
      return send(200, {
        samples: render((await readBody(request)) as CardTemplates),
      });
    if (request.method === "POST" && request.url === "/api/save") {
      const templates = (await readBody(request)) as CardTemplates;
      render(templates);
      const text = await format(JSON.stringify(templates), { parser: "json" });
      await writeFile(TEMPLATE_FILE, text);
      // Read it back, so the page only says saved when the file says so.
      const written = await readFile(TEMPLATE_FILE, "utf8");
      if (written !== text) throw new Error("파일에 쓴 내용이 다릅니다");
      console.log(`${new Date().toLocaleTimeString()} 저장: ${TEMPLATE_FILE}`);
      return send(200, { saved: TEMPLATE_FILE, at: new Date().toISOString() });
    }
    send(404, { error: "not_found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(
      `${new Date().toLocaleTimeString()} ${request.method} ${request.url} 실패: ${message}`,
    );
    send(400, { error: message });
  }
});

// Only this machine: the page writes into the repository.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`카드 스튜디오: http://127.0.0.1:${PORT}`);
});
