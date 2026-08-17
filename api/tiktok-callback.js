// Serverless Function (Vercel) — callback de autorizacao da TikTok Marketing API.
//
// Fluxo: o admin da conta de Ads aprova em business-api.tiktok.com/portal/auth
// e o TikTok redireciona para /callback/tiktok?auth_code=...&state=...
// Aqui trocamos esse auth_code (uso unico, ~10 min) pelo access_token de longa
// duracao (a Marketing API NAO expira o token) + a lista de advertiser_ids liberados.
//
// Segredos vem SEMPRE de variaveis de ambiente do Vercel — nunca hardcode:
//   TIKTOK_APP_ID       -> 7625541869962788881
//   TIKTOK_APP_SECRET   -> (o "Secret" do app no portal business-api)
//   TIKTOK_EXPECTED_STATE (opcional) -> bi_mkt  (se definido, valida o state)

const TOKEN_URL =
  "https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/";

function page({ title, bodyHtml }) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link rel="shortcut icon" href="/favicon.ico" type="image/x-icon">
  <link rel="stylesheet" href="/styles.css">
  <style>
    .cb-wrap { max-width: 720px; margin: 8vh auto; padding: 0 1.5rem; }
    .cb-card { border: 1px solid rgba(255,255,255,.12); border-radius: 14px; padding: 2rem; }
    .cb-code { font-family: "Space Mono", monospace; font-size: .85rem; word-break: break-all;
               background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.12);
               border-radius: 8px; padding: 1rem; margin: .75rem 0; }
    .cb-label { font-size: .8rem; letter-spacing: .04em; text-transform: uppercase; opacity: .6; margin-top: 1.25rem; }
    .cb-ok { color: #4ade80; } .cb-err { color: #f87171; }
  </style>
</head>
<body>
  <div class="cb-wrap"><div class="cb-card">${bodyHtml}</div></div>
</body>
</html>`;
}

module.exports = async (req, res) => {
  const { auth_code, code, state, error, error_description } = req.query || {};
  const authCode = auth_code || code; // o TikTok usa "auth_code"; aceitamos "code" por seguranca

  // TikTok pode voltar com erro (ex.: usuario cancelou)
  if (error) {
    res.status(400).setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(
      page({
        title: "Autorizacao nao concluida",
        bodyHtml: `<h1 class="cb-err">Autorizacao nao concluida</h1>
          <p>${error}: ${error_description || ""}</p>`,
      })
    );
  }

  if (!authCode) {
    res.status(400).setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(
      page({
        title: "Parametro ausente",
        bodyHtml: `<h1 class="cb-err">Faltou o auth_code</h1>
          <p>Esta pagina deve ser aberta pelo redirecionamento do TikTok apos a autorizacao.</p>`,
      })
    );
  }

  // Validacao opcional do state (anti-CSRF)
  const expectedState = process.env.TIKTOK_EXPECTED_STATE;
  if (expectedState && state !== expectedState) {
    res.status(400).setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(
      page({
        title: "State invalido",
        bodyHtml: `<h1 class="cb-err">State nao confere</h1>
          <p>Esperado <code>${expectedState}</code>, recebido <code>${state || "(vazio)"}</code>.</p>`,
      })
    );
  }

  const appId = process.env.TIKTOK_APP_ID;
  const secret = process.env.TIKTOK_APP_SECRET;
  if (!appId || !secret) {
    res.status(500).setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(
      page({
        title: "Configuracao incompleta",
        bodyHtml: `<h1 class="cb-err">Faltam variaveis de ambiente</h1>
          <p>Defina <code>TIKTOK_APP_ID</code> e <code>TIKTOK_APP_SECRET</code> no Vercel.</p>`,
      })
    );
  }

  try {
    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, secret, auth_code: authCode }),
    });
    const json = await resp.json();

    // A Marketing API retorna code:0 em caso de sucesso
    if (!json || json.code !== 0 || !json.data || !json.data.access_token) {
      // Log completo fica so nos Runtime Logs do Vercel (visivel so pra voce, o dono)
      console.error("TikTok token exchange falhou:", JSON.stringify(json));
      res.status(502).setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send(
        page({
          title: "Falha na troca do token",
          bodyHtml: `<h1 class="cb-err">Nao consegui trocar o codigo pelo token</h1>
            <p>Mensagem do TikTok: <code>${(json && json.message) || "desconhecida"}</code></p>
            <p>Se o codigo expirou (>10 min), refaca a autorizacao.</p>`,
        })
      );
    }

    const data = json.data;
    const advertiserIds = data.advertiser_ids || data.advertiser_id || [];

    // Registra nos Runtime Logs do Vercel (acessivel apenas por voce no dashboard).
    console.log(
      "TIKTOK_AUTH_OK",
      JSON.stringify({
        access_token: data.access_token,
        scope: data.scope,
        advertiser_ids: advertiserIds,
      })
    );

    res.status(200).setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(
      page({
        title: "Autorizacao concluida",
        bodyHtml: `
          <h1 class="cb-ok">Autorizacao concluida ✅</h1>
          <p>O acesso aos dados de Ads foi liberado com sucesso. Pode fechar esta pagina.</p>

          <p class="cb-label">access_token (guarde com seguranca)</p>
          <div class="cb-code">${data.access_token}</div>

          <p class="cb-label">advertiser_ids liberados</p>
          <div class="cb-code">${JSON.stringify(advertiserIds)}</div>
        `,
      })
    );
  } catch (err) {
    console.error("Erro inesperado no callback TikTok:", err);
    res.status(500).setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(
      page({
        title: "Erro inesperado",
        bodyHtml: `<h1 class="cb-err">Erro inesperado</h1>
          <p>Tente novamente. Se persistir, verifique os Runtime Logs no Vercel.</p>`,
      })
    );
  }
};
