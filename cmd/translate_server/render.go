package main

import (
	"fmt"
	"net/url"
	"strings"
)

// ---------------------------------------------------------------------------
// HTML templates (inline CSS, large font)
// ---------------------------------------------------------------------------

func renderSuccess(text, translated, sl, tl string, alreadySaved bool) string {
	// Build play button (only for English source)
	playBtn := ""
	if strings.HasPrefix(strings.ToLower(sl), "en") {
		playBtn = fmt.Sprintf(`
    <button id="playBtn" onclick="playTTS()" style="
      padding:16px 48px; font-size:28px;
      border:none; border-radius:16px; cursor:pointer;
      background:linear-gradient(135deg,rgba(167,139,250,0.3),rgba(96,165,250,0.3));
      color:#e0e0e0; transition:all 0.25s ease;
      display:inline-flex; align-items:center; gap:12px;
      box-shadow:0 4px 16px rgba(0,0,0,0.3);
    " onmouseover="this.style.transform='scale(1.05)';this.style.boxShadow='0 6px 24px rgba(167,139,250,0.4)'"
       onmouseout="this.style.transform='scale(1)';this.style.boxShadow='0 4px 16px rgba(0,0,0,0.3)'"
    >🔊 Play</button>
    <script>
    function playTTS(){
      var btn=document.getElementById('playBtn');
      btn.innerText='🔊 Playing...';
      btn.disabled=true;
      btn.style.opacity='0.6';
      fetch('/play?text=%s')
        .then(function(){btn.innerText='🔊 Play';btn.disabled=false;btn.style.opacity='1';})
        .catch(function(){btn.innerText='🔊 Play';btn.disabled=false;btn.style.opacity='1';});
    }
    </script>`, url.QueryEscape(text))
	}

	saveBtn := `
    <span id="saveStatus" style="
      padding:16px 48px; font-size:28px;
      border-radius:16px;
      background:linear-gradient(135deg,rgba(74,222,128,0.2),rgba(34,197,94,0.2));
      color:#bbf7d0;
      display:inline-flex; align-items:center; gap:12px;
      border:1px solid rgba(187,247,208,0.25);
    ">✅ 已在错题本</span>`
	if !alreadySaved {
		saveBtn = fmt.Sprintf(`
    <button id="saveBtn" onclick="saveWord()" style="
      padding:16px 48px; font-size:28px;
      border:none; border-radius:16px; cursor:pointer;
      background:linear-gradient(135deg,rgba(74,222,128,0.3),rgba(59,130,246,0.3));
      color:#e0e0e0; transition:all 0.25s ease;
      display:inline-flex; align-items:center; gap:12px;
      box-shadow:0 4px 16px rgba(0,0,0,0.3);
    " onmouseover="this.style.transform='scale(1.05)';this.style.boxShadow='0 6px 24px rgba(74,222,128,0.4)'"
       onmouseout="this.style.transform='scale(1)';this.style.boxShadow='0 4px 16px rgba(0,0,0,0.3)'"
    >➕ 加入错题本</button>
    <script>
    function showSavedStatus(label){
      var btn=document.getElementById('saveBtn');
      if(!btn){return;}
      var status=document.createElement('span');
      status.id='saveStatus';
      status.innerText=label;
      status.setAttribute('style',
        'padding:16px 48px; font-size:28px; border-radius:16px;' +
        'background:linear-gradient(135deg,rgba(74,222,128,0.2),rgba(34,197,94,0.2));' +
        'color:#bbf7d0; display:inline-flex; align-items:center; gap:12px;' +
        'border:1px solid rgba(187,247,208,0.25);'
      );
      btn.replaceWith(status);
    }
    function saveWord(){
      var btn=document.getElementById('saveBtn');
      btn.innerText='保存中...';
      btn.disabled=true;
      btn.style.opacity='0.6';
      fetch('/save?text=%s&translated=%s&sl=%s')
        .then(function(res){
          return res.text().then(function(body){return {ok:res.ok, body:body};});
        })
        .then(function(result){
          if(result.ok){
            showSavedStatus(result.body === 'exists' ? '✅ 已在错题本' : '✅ 已加入错题本');
          }else{
            btn.innerText='保存失败';
            btn.disabled=false;
            btn.style.opacity='1';
          }
        })
        .catch(function(){
            btn.innerText='保存失败';
            btn.disabled=false;
            btn.style.opacity='1';
        });
    }
    </script>`, url.QueryEscape(text), url.QueryEscape(translated), url.QueryEscape(sl))
	}

	return fmt.Sprintf(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Translate</title>
</head>
<body style="
  margin:0; min-height:100vh;
  display:flex; align-items:center; justify-content:center;
  background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);
  font-family:'Segoe UI',system-ui,sans-serif; color:#e0e0e0;
">
  <div style="
    background:rgba(255,255,255,0.06);
    backdrop-filter:blur(12px);
    border:1px solid rgba(255,255,255,0.12);
    border-radius:24px; padding:48px 56px;
    max-width:680px; width:90%%;
    box-shadow:0 8px 32px rgba(0,0,0,0.4);
    text-align:center;
  ">
    <p style="font-size:14px;opacity:0.5;margin:0 0 8px;letter-spacing:2px;">%s → %s</p>
    <p style="font-size:42px;font-weight:700;margin:0 0 16px;
              background:linear-gradient(90deg,#a78bfa,#60a5fa);
              -webkit-background-clip:text;-webkit-text-fill-color:transparent;">%s</p>
    <hr style="border:none;border-top:1px solid rgba(255,255,255,0.1);margin:20px 0;">
    <p style="font-size:36px;font-weight:400;margin:0;color:#c4b5fd;">%s</p>
    <div style="margin-top:28px; display:flex; justify-content:center; gap:16px; flex-wrap:wrap;">
      %s
      %s
    </div>
  </div>
</body>
</html>`,
		htmlEscape(strings.ToUpper(sl)),
		htmlEscape(strings.ToUpper(tl)),
		htmlEscape(text),
		htmlEscape(translated),
		playBtn,
		saveBtn,
	)
}

func renderError(msg string) string {
	return fmt.Sprintf(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Error</title>
</head>
<body style="
  margin:0; min-height:100vh;
  display:flex; align-items:center; justify-content:center;
  background:linear-gradient(135deg,#1a0000,#4a1942,#1a0000);
  font-family:'Segoe UI',system-ui,sans-serif; color:#e0e0e0;
">
  <div style="
    background:rgba(255,60,60,0.08);
    backdrop-filter:blur(12px);
    border:1px solid rgba(255,100,100,0.2);
    border-radius:24px; padding:48px 56px;
    max-width:600px; width:90%%;
    box-shadow:0 8px 32px rgba(0,0,0,0.5);
    text-align:center;
  ">
    <p style="font-size:48px;margin:0 0 12px;">⚠️</p>
    <p style="font-size:24px;font-weight:600;margin:0 0 16px;color:#fca5a5;">Something went wrong</p>
    <p style="font-size:16px;opacity:0.7;margin:0;">%s</p>
  </div>
</body>
</html>`, htmlEscape(msg))
}

// htmlEscape without html/template – just the 5 XML entities
func htmlEscape(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	s = strings.ReplaceAll(s, `"`, "&quot;")
	s = strings.ReplaceAll(s, "'", "&#39;")
	return s
}
