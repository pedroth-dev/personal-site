// Serverless Function (Vercel) — callback de autorizacao do LinkedIn (Marketing/Ads).
//
// Fluxo OAuth 2.0 (3-legged): voce abre a URL de autorizacao logado no SEU perfil
// (o mesmo que foi adicionado como user na Ad Account do cliente) e o LinkedIn
// redireciona para /callback/linkedin?code=...&state=...
// Aqui trocamos o `code` (uso unico, ~30 min) por:
//   - access_token  (expira em ~60 dias)
//   - refresh_token (expira em ~365 dias) -> renova o access_token sem reautorizar
//
// Segredos vem SEMPRE de variaveis de ambiente do Vercel:
//   LINKEDIN_CLIENT_ID
//   LINKEDIN_CLIENT_SECRET
//   LINKEDIN_REDIRECT_URI      -> https://pedrothdev.com.br/callback/linkedin
//   LINKEDIN_EXPECTED_STATE    (opcional) -> bi_mkt

const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";

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
  const { code, state, error, error_description } = req.query || {};

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

  if (!code) {
    res.status(400).setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(
      page({
        title: "Parametro ausente",
        bodyHtml: `<h1 class="cb-err">Faltou o code</h1>
          <p>Esta pagina deve ser aberta pelo redirecionamento do LinkedIn apos a autorizacao.</p>`,
      })
    );
  }

  const expectedState = process.env.LINKEDIN_EXPECTED_STATE;
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

  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
  const redirectUri = process.env.LINKEDIN_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    res.status(500).setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(
      page({
        title: "Configuracao incompleta",
        bodyHtml: `<h1 class="cb-err">Faltam variaveis de ambiente</h1>
          <p>Defina <code>LINKEDIN_CLIENT_ID</code>, <code>LINKEDIN_CLIENT_SECRET</code> e
          <code>LINKEDIN_REDIRECT_URI</code> no Vercel.</p>`,
      })
    );
  }

  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    });

    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const json = await resp.json();

    if (!resp.ok || !json || !json.access_token) {
      console.error("LinkedIn token exchange falhou:", JSON.stringify(json));
      res.status(502).setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send(
        page({
          title: "Falha na troca do token",
          bodyHtml: `<h1 class="cb-err">Nao consegui trocar o code pelo token</h1>
            <p>Resposta do LinkedIn: <code>${(json && (json.error_description || json.error)) || "desconhecida"}</code></p>
            <p>Se o code expirou (>30 min) ou o redirect_uri nao bate, refaca a autorizacao.</p>`,
        })
      );
    }

    // Log completo nos Runtime Logs do Vercel (visivel so pra voce, o dono).
    console.log(
      "LINKEDIN_AUTH_OK",
      JSON.stringify({
        access_token: json.access_token,
        expires_in: json.expires_in,
        refresh_token: json.refresh_token || null,
        refresh_token_expires_in: json.refresh_token_expires_in || null,
        scope: json.scope,
      })
    );

    const days = json.expires_in ? Math.round(json.expires_in / 86400) : "?";
    const refreshBlock = json.refresh_token
      ? `<p class="cb-label">refresh_token (renova o acesso — guarde!)</p>
         <div class="cb-code">${json.refresh_token}</div>`
      : `<p class="cb-label">refresh_token</p>
         <div class="cb-code">nao emitido — o app precisa de refresh token habilitado.
         Sem ele, sera necessario reautorizar a cada ~${days} dias.</div>`;

    res.status(200).setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(
      page({
        title: "Autorizacao concluida",
        bodyHtml: `
          <h1 class="cb-ok">Autorizacao concluida ✅</h1>
          <p>Acesso concedido. O access_token vale ~${days} dias. Pode fechar esta pagina.</p>

          <p class="cb-label">access_token</p>
          <div class="cb-code">${json.access_token}</div>

          ${refreshBlock}

          <p class="cb-label">scopes concedidos</p>
          <div class="cb-code">${json.scope || "(nao informado)"}</div>
        `,
      })
    );
  } catch (err) {
    console.error("Erro inesperado no callback LinkedIn:", err);
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
