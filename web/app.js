const device=document.querySelector('#device'),token=document.querySelector('#token'),status=document.querySelector('#status'),notice=document.querySelector('#notice'),shots=document.querySelector('#shots'),refreshShots=document.querySelector('#refreshShots');
let shotUrls=[];
token.value=sessionStorage.token||'';token.onchange=()=>{sessionStorage.token=token.value;void loadShots()};
const authHeaders=()=>({authorization:'Bearer '+token.value});
async function refresh(){try{const r=await fetch('/api/control/status?device='+encodeURIComponent(device.value));const j=await r.json();const x=j.status;if(!x){status.textContent='裝置未連線';return}const age=Math.max(0,Math.floor((j.serverTime-x.lastSeen)/1000));status.textContent=`${x.status}\n最後連線：${age} 秒前\nWatchdog：${x.watchdogEnabled?'已啟用':'已停用'}\n刷券：${x.ticketKnown?(x.ticketRunning?'ON':'OFF'):'—'}`}catch(e){status.textContent='連線錯誤：'+e.message}}
async function loadShots(){
  if(!token.value){shots.innerHTML='<div class="empty">請先輸入 Control token</div>';return}
  refreshShots.disabled=true;shots.innerHTML='<div class="empty">載入截圖中…</div>';
  try{
    const r=await fetch('/api/control/screenshots?device='+encodeURIComponent(device.value)+'&limit=20',{headers:authHeaders()});
    if(!r.ok)throw Error(r.status===401?'Token不正確':await r.text());
    const list=(await r.json()).screenshots;shotUrls.forEach(URL.revokeObjectURL);shotUrls=[];shots.replaceChildren();
    if(!list.length){shots.innerHTML='<div class="empty">未有歷史截圖</div>';return}
    for(const item of list){
      const imageResponse=await fetch('/api/control/screenshots/'+item.id,{headers:authHeaders()});if(!imageResponse.ok)continue;
      const url=URL.createObjectURL(await imageResponse.blob());shotUrls.push(url);
      const card=document.createElement('div');card.className='shot';
      const img=document.createElement('img');img.src=url;img.alt=item.event+'遊戲截圖';img.loading='lazy';
      const meta=document.createElement('div');meta.className='shot-meta';meta.textContent=new Date(item.capturedAt).toLocaleString()+' · '+item.event;
      card.append(img,meta);shots.append(card);
    }
  }catch(e){shots.innerHTML='<div class="empty">載入失敗：'+String(e.message).replace(/[<>]/g,'')+'</div>'}finally{refreshShots.disabled=false}
}
async function waitForNewShot(previousFirst){for(let attempt=1;attempt<=12;attempt++){notice.textContent=`等待Android截圖… ${attempt*5}/60秒`;await new Promise(r=>setTimeout(r,5000));const r=await fetch('/api/control/screenshots?device='+encodeURIComponent(device.value)+'&limit=1',{headers:authHeaders()});if(r.ok){const first=(await r.json()).screenshots[0]?.id;if(first&&first!==previousFirst){await loadShots();notice.textContent='截圖完成並已保存';return}}}notice.textContent='截圖逾時'}
refreshShots.onclick=()=>loadShots();
document.querySelectorAll('[data-command]').forEach(button=>button.onclick=async()=>{if(!token.value){notice.textContent='請輸入 token';return}button.disabled=true;try{let previousFirst=null;if(button.dataset.command==='CAPTURE_SCREEN'){const before=await fetch('/api/control/screenshots?device='+encodeURIComponent(device.value)+'&limit=1',{headers:authHeaders()});if(before.ok)previousFirst=(await before.json()).screenshots[0]?.id||null}const r=await fetch('/api/control/command',{method:'POST',headers:{...authHeaders(),'content-type':'application/json'},body:JSON.stringify({device:device.value,command:button.dataset.command})});notice.textContent=r.ok?'指令已送出':'失敗：'+await r.text();if(r.ok&&button.dataset.command==='CAPTURE_SCREEN')void waitForNewShot(previousFirst)}finally{button.disabled=false}});
refresh();setInterval(refresh,10000);
