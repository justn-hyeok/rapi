import {
  sendSuggestion,
  validHelpToken,
  type HelpSite,
} from "@rapi/application";
import { page } from "./site-page.js";

const json = (status: number, body: unknown) => ({
  status,
  type: "application/json",
  body: JSON.stringify(body),
});

const EVERYONE: Array<[string, string]> = [
  ["/도움말", "이 안내 링크를 받습니다."],
  ["/스타 켜기", "GitHub를 연결하고 매일 아침 스타 DM을 받기 시작합니다."],
  ["/스타 관심사", "관심사를 고르는 페이지 링크를 받습니다."],
  ["/스타 보기", "받고 있는지와 멈춘 이유를 봅니다."],
  ["/스타 끄기", "DM을 끄고 저장한 기록을 지웁니다."],
  ["/연결 추가", "GitHub 계정을 연결합니다."],
  ["/연결 보기", "연결한 계정을 봅니다."],
  ["/연결 끊기", "연결을 끊고 토큰을 지웁니다."],
  ["/제보", "AI 할인이나 새 서비스 링크를 운영자에게 알립니다."],
];

const ADMINS: Array<[string, string]> = [
  ["/서버신청", "이 서버에서 라피를 쓸 수 있게 승인을 요청합니다."],
  ["/ai-할인-알림 켜기·끄기·보기", "AI 할인 카드를 받을 채널을 정합니다."],
  [
    "/새-서비스-알림 켜기·끄기·보기",
    "새 AI 서비스 소식을 받을 채널을 정합니다.",
  ],
  [
    "/라피-업데이트-알림 켜기·끄기·보기",
    "라피 새 버전 소식을 받을 채널을 정합니다.",
  ],
];

const list = (rows: Array<[string, string]>) =>
  `<ul>${rows.map(([command, text]) => `<li><code>${command}</code> ${text}</li>`).join("")}</ul>`;

const SCRIPT = `<script>
const button = document.getElementById("send");
const status = document.getElementById("status");
const area = document.getElementById("text");
button.addEventListener("click", async () => {
  button.disabled = true;
  try {
    const answer = await fetch("/help/suggestions" + location.search, {
      method: "POST",
      body: JSON.stringify({ text: area.value }),
    });
    if (answer.status === 200) {
      status.textContent = "보냈습니다. 고맙습니다.";
      area.value = "";
    } else if (answer.status === 400) {
      status.textContent = "내용을 1000자 안으로 적어 주세요.";
    } else if (answer.status === 401) {
      status.textContent = "링크가 만료됐습니다. Discord에서 /도움말을 다시 해 주세요.";
    } else if (answer.status === 429) {
      status.textContent = "한 시간에 5건까지 보낼 수 있어요. 나중에 다시 보내 주세요.";
    } else {
      status.textContent = "지금은 보내지 못했습니다. 잠시 뒤 다시 해 주세요.";
    }
  } catch {
    status.textContent = "지금은 보내지 못했습니다. 잠시 뒤 다시 해 주세요.";
  } finally {
    button.disabled = false;
  }
});
</script>`;

const helpBody = (signedIn: boolean) =>
  `<h1>라피 도움말</h1>` +
  `<h2>누구나</h2>${list(EVERYONE)}` +
  `<h2>서버 관리자</h2>${list(ADMINS)}` +
  `<p>기능은 서버마다 꺼져 있을 수 있어요.</p>` +
  `<h2>건의</h2>` +
  (signedIn
    ? `<p>필요한 기능, 불편한 점, 뭐든 적어 주세요. 운영자에게 바로 전달되고, 보낸 사람이 누구인지도 같이 전달됩니다.</p><textarea id="text" rows="6" maxlength="1000" style="width:100%"></textarea><p><button id="send" type="button">보내기</button></p><p id="status" role="status"></p>${SCRIPT}`
    : `<p>건의는 Discord에서 /도움말로 받은 링크에서 남길 수 있어요.</p>`) +
  `<p><a href="/">라피 소개</a> · <a href="/privacy">개인정보 안내</a></p>`;

/**
 * The /help page: GET lists the commands and, with a valid signed link, the
 * suggestion form; POST /help/suggestions sends one to the owner's review
 * channel. Other paths and methods are not this page's, so it answers null.
 */
export function helpPages(site: HelpSite | undefined) {
  return async (
    method: string,
    url: URL,
    body: () => Promise<Buffer>,
  ): Promise<{ status: number; type: string; body: string } | null> => {
    const now = new Date();
    const u = url.searchParams.get("u");
    const t = url.searchParams.get("t");
    const valid = !!site && validHelpToken(site, u, t, now);
    if (method === "GET" && url.pathname === "/help")
      return {
        status: 200,
        type: "text/html",
        body: page("라피 · 도움말", helpBody(valid)),
      };
    if (method === "POST" && url.pathname === "/help/suggestions") {
      if (!site) return null;
      if (!valid) return json(401, { error: "expired" });
      let text: unknown;
      try {
        text = (
          JSON.parse((await body()).toString("utf8")) as { text?: unknown }
        ).text;
      } catch {
        return json(400, { error: "empty" });
      }
      const outcome = await sendSuggestion(site, u ?? "", text, now);
      switch (outcome) {
        case "sent":
          return json(200, { sent: true });
        case "empty":
        case "too_long":
          return json(400, { error: outcome });
        case "limited":
          return json(429, { error: "limited" });
        default:
          return json(503, { error: outcome });
      }
    }
    return null;
  };
}
