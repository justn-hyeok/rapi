const style =
  "<style>body{font:16px/1.6 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#1f2328;background:#fff}h1{font-size:1.25rem}h2{font-size:1.05rem}footer{margin-top:3rem;font-size:0.85rem}footer a{margin-right:1rem}@media (prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1117}a{color:#79c0ff}}</style>";

const page = (title: string, body: string) =>
  `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>${style}${body}</html>`;

const introPage = (applicationId: string) =>
  page(
    "라피",
    `<h1>라피</h1><p>AI 할인 소식과 잊고 있던 GitHub 스타를 Discord로 챙겨 주는 봇입니다. Justn과 주변 사람들이 쓰려고 만들었고, 돈을 받지 않습니다.</p><h2>할 수 있는 일</h2><ul><li>AI 할인·새 서비스 알림: 운영자가 확인한 카드를 정해 둔 채널로 보내 줍니다.</li><li>스타 알림: GitHub를 연결하면 잊고 있던 스타와 새로 찾은 저장소를 매일 아침 DM으로 보내 줍니다.</li><li>제보: AI 할인이나 새 서비스 링크를 운영자에게 알립니다.</li></ul><h2>서버에 넣기</h2><ol><li>아래 링크로 라피를 서버에 초대합니다.</li><li>서버 관리 권한이 있는 분이 /서버신청을 합니다.</li><li>운영자가 승인하면 명령을 쓸 수 있습니다. 승인 전에는 /서버신청만 됩니다.</li><li>/도움말로 쓸 수 있는 명령을 봅니다.</li></ol><p><a href="https://discord.com/oauth2/authorize?client_id=${applicationId}&amp;scope=bot+applications.commands&amp;permissions=19456">라피 초대하기</a></p><footer><a href="/privacy">개인정보 안내</a><a href="https://github.com/justn-hyeok/rapi">GitHub</a><p>승리의 여신: 니케의 비공식 팬 봇이며, SHIFT UP, Level Infinite와 관계없습니다.</p></footer>`,
  );

const privacyPage = page(
  "라피 · 개인정보 안내",
  `<h1>개인정보 안내</h1><p>마지막 수정: 2026-11-10</p><h2>저장하는 것</h2><ul><li>Discord 사용자 ID와 서버 ID: 명령 처리, 알림 설정, 서버 승인에 씁니다.</li><li>GitHub 연결: GitHub 계정 ID와 이름, 암호화한 액세스 토큰. 권한을 요청하지 않아서 공개 정보만 읽습니다.</li><li>스타 알림: 공개 스타 목록, 고른 관심사, 👍/👎, 보낸 기록, 취향이 비슷한 GitHub 계정.</li><li>/제보: 보낸 사람의 Discord ID, 링크, 메모.</li><li>/서버신청: 신청한 사람의 Discord ID, 서버 이름, 사유.</li></ul><p>라피는 서버의 일반 메시지를 읽지 않습니다.</p><h2>쓰는 곳</h2><p>라피 기능을 돌리는 데만 씁니다. 팔거나 광고에 쓰지 않습니다. AI 모델은 공개된 글을 고르고 번역하는 데만 쓰고, 위에 적은 정보는 AI 모델에 보내지 않습니다.</p><h2>지우는 법</h2><ul><li>/스타 끄기: 스타, 관심사, 👍/👎, 보낸 기록, 취향이 비슷한 계정 기록을 지웁니다.</li><li>/연결 끊기: GitHub 쪽 권한을 회수하고 토큰을 지웁니다.</li><li>그 밖에 지우고 싶은 것이 있으면 Justn에게 말해 주세요.</li></ul><p>매일 만드는 백업은 30일 동안 보관하므로, 지운 정보도 백업에는 최대 30일 남아 있습니다.</p><p><a href="/">라피 소개로 돌아가기</a></p>`,
);

/**
 * The public intro and privacy pages: GET / and GET /privacy. Other paths and
 * methods are not this page's, so it answers null.
 */
export function sitePages(applicationId: string) {
  return (
    method: string,
    url: URL,
  ): { status: number; type: string; body: string } | null => {
    if (method !== "GET") return null;
    if (url.pathname === "/")
      return { status: 200, type: "text/html", body: introPage(applicationId) };
    if (url.pathname === "/privacy")
      return { status: 200, type: "text/html", body: privacyPage };
    return null;
  };
}
