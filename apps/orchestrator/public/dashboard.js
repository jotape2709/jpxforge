import { team, createOffice } from '/office.js';
const $=id=>document.getElementById(id);
const office=createOffice($('office'));
const names=Object.fromEntries(team.map(p=>[p.role,p.name]));names.security='Sento';names.narrator='Escritório';
const statuses={intake:'Especificação',planned:'Planejamento',building:'Construindo',review:'Em revisão',shipped:'Push concluído',quarantine:'Quarentena',aborted:'Interrompido'};
const taskNames={queued:'Na fila',running:'Em execução',done:'Concluída',failed:'Falhou',blocked:'Bloqueada'};
let selected=null, projects=[], details=null, demo=false, live=false, socket, reconnectTimer, refreshTimer, reconnectDelay=1000, disposed=false;
let publishing=false, publishProject=null;
const events=new Map();let toastTimer, submitting=false;
function element(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;}
async function api(url,options={}){
  const response=await fetch(url,{...options,headers:{'Content-Type':'application/json',...options.headers},signal:AbortSignal.timeout(10000)});
  const data=await response.json();
  if(!response.ok)throw new Error(typeof data.error==='string'?data.error:'Não foi possível concluir. Confira o briefing e tente novamente.');
  return data;
}
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,6000);}
function openDialog(){ $('form-error').hidden=true;$('briefing-dialog').showModal();$('briefing').focus(); }
$('new-project').onclick=openDialog;$('close-dialog').onclick=()=>$('briefing-dialog').close();
$('example').onclick=()=>{$('briefing').value='Crie uma landing page para o Estúdio Aurora, um negócio fictício de design. Apresente identidade visual, criação de páginas e conteúdo, com uma seção de contato e navegação responsiva. Não invente telefone, clientes ou avaliações.';$('briefing').focus();};
$('briefing-form').onsubmit=async event=>{
  event.preventDefault();if(submitting)return;submitting=true;$('submit-briefing').disabled=true;$('form-error').hidden=true;
  try{const result=await api('/briefings',{method:'POST',body:JSON.stringify({source:'manual',raw_text:$('briefing').value})});selected=result.project_id;$('briefing-dialog').close();await refresh();toast(demo?'Demonstração iniciada. A equipe usará o exemplo Aurora.':'Projeto entrou na fila.');}
  catch(error){$('form-error').textContent=error.message;$('form-error').hidden=false;}
  finally{submitting=false;$('submit-briefing').disabled=false;}
};
$('abort').onclick=async()=>{
  if(!selected)return;$('abort').disabled=true;
  try{await api(`/projects/${selected}/abort`,{method:'POST',body:'{}'});await refresh();toast('Projeto interrompido.');}catch(error){toast(error.message);}finally{$('abort').disabled=false;}
};
$('publish').onclick=()=>{publishProject=selected;$('branch').value=`joao2709/forge-${selected}`;$('remote').value='';$('publish-error').hidden=true;$('publish-dialog').showModal();$('remote').focus();};
$('close-publish').onclick=()=>$('publish-dialog').close();
$('publish-form').onsubmit=async event=>{
  event.preventDefault();if(publishing||!publishProject)return;publishing=true;$('submit-publish').disabled=true;$('publish-error').hidden=true;
  try{await api(`/projects/${publishProject}/publish`,{method:'POST',body:JSON.stringify({remote:$('remote').value.trim(),branch:$('branch').value.trim()})});$('publish-dialog').close();await refresh();toast('Envio entrou na fila deste projeto.');}
  catch(error){$('publish-error').textContent=error.message;$('publish-error').hidden=false;}
  finally{publishing=false;$('submit-publish').disabled=false;}
};
function renderProjects(){
  $('project-count').textContent=String(projects.length);$('projects').replaceChildren();
  if(!projects.length){$('projects').append(element('p','empty','Nenhum projeto ainda. Comece com uma ideia.'));return;}
  for(const project of projects){const button=element('button','project-card'+(selected===project.id?' selected':''));button.type='button';button.setAttribute('aria-pressed',String(selected===project.id));
    button.append(element('strong','',project.spec?.title||'Novo projeto'),element('span','mini-status',statuses[project.status]||project.status),element('small','',new Date(project.created_at).toLocaleDateString('pt-BR',{day:'2-digit',month:'short'})));
    button.onclick=()=>{selected=project.id;details=null;renderProjects();renderDetails();renderChat();void refresh().catch(error=>toast(error.message));};$('projects').append(button);}
}
function renderDetails(){
  const project=details?.project, tasks=details?.tasks||[];
  $('project-title').textContent=project?.spec?.title||(project?'Organizando o briefing…':'Sua próxima ideia começa aqui.');
  $('project-summary').textContent=project?.spec?.summary||project?.briefing?.raw_text||'Envie um briefing e acompanhe a equipe organizar, construir e verificar a entrega.';
  const delivered=tasks.some(t=>t.payload.kind==='publish_landing'&&t.status==='done');
  const pending=tasks.some(t=>t.status==='running'||t.status==='queued');
  $('project-status').textContent=project?(delivered&&project.status==='review'?(pending?'Envio em andamento':'Pronto para revisão'):statuses[project.status]):'Nenhum projeto';
  $('tasks').replaceChildren();
  for(const task of tasks){const node=element('div',`task ${task.status}`);node.append(element('span','task-icon',({done:'✓',running:'◉',queued:'○',failed:'!',blocked:'−'})[task.status]||'○'),element('span','',task.title),element('small','',`${names[task.role]||task.role} · ${taskNames[task.status]||task.status}`));$('tasks').append(node);}
  $('tokens').textContent=`${(details?.tokens||[]).reduce((sum,row)=>sum+row.prompt_tokens+row.completion_tokens,0).toLocaleString('pt-BR')} tokens`;
  $('cost-note').textContent=demo?'Modo demonstração · nenhuma API paga':'Custo monetário ainda não estimado';
  $('abort').hidden=!project||['aborted','quarantine','shipped'].includes(project.status)||(delivered&&!pending);
  $('publish').hidden=demo||!project||project.status!=='review'||!delivered||tasks.some(t=>t.status!=='done');
  const preview=project&&['review','shipped'].includes(project.status)&&tasks.some(t=>t.payload.kind==='qa_landing'&&t.status==='done');
  $('preview').hidden=!preview;if(preview)$('preview').href=`/preview/${project.id}/index.html`;else $('preview').removeAttribute('href');
  const error=tasks.find(t=>['failed','blocked'].includes(t.status)&&t.error)?.error;
  $('project-error').hidden=!error;$('project-error').textContent=error||'';
  const active=tasks.filter(t=>t.status==='running').map(t=>t.role);office.update(active);
  $('office-status').textContent=active.length?`${names[active[0]]||'Equipe'} trabalhando`:project?(delivered?'Entrega pronta':'Equipe disponível'):'Aguardando projeto';
  $('roster').replaceChildren();for(const person of team){const working=active.includes(person.role);const node=element('div','person'+(working?' working':''));node.append(element('strong','',person.name),element('small','',person.job),element('span',working?'':'idle',working?'Trabalhando':'Disponível'));$('roster').append(node);}
}
function renderChat(){
  const chat=$('chat'), nearBottom=chat.scrollHeight-chat.scrollTop-chat.clientHeight<70;
  const messages=[...events.values()].filter(e=>e.project_id===selected&&['agent.say','project.status','task.failed'].includes(e.type)).sort((a,b)=>a.ts.localeCompare(b.ts)).slice(-100);
  chat.replaceChildren();
  if(!messages.length)chat.append(element('p','empty',selected?'As atualizações da equipe aparecerão aqui.':'Selecione ou crie um projeto para acompanhar a conversa.'));
  for(const message of messages){const entry=element('article','chat-entry');const name=names[message.role]||'Forge';const meta=element('div','chat-meta');const time=element('time','',new Date(message.ts).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}));time.dateTime=message.ts;meta.append(element('span','chat-avatar',name.slice(0,1)),element('strong','',name),time);entry.append(meta,element('p','',message.message));chat.append(entry);}
  if(nearBottom)chat.scrollTop=chat.scrollHeight;
}
function remember(incoming){for(const event of incoming){if(typeof event.id==='string'&&typeof event.ts==='string'&&typeof event.message==='string')events.set(event.id,event);}while(events.size>500)events.delete(events.keys().next().value);}
let refreshing=false,refreshAgain=false;
async function refresh(){
  if(refreshing){refreshAgain=true;return;}refreshing=true;
  try{const result=await api('/projects');projects=result.projects;if(!projects.some(p=>p.id===selected))selected=projects[0]?.id||null;renderProjects();
    const target=selected;if(target){const data=await api(`/briefings/${target}`);if(selected===target)details=data;}else details=null;
    renderDetails();renderChat();
  }finally{refreshing=false;if(refreshAgain){refreshAgain=false;void refresh().catch(error=>toast(error.message));}}
}
function scheduleRefresh(){clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>void refresh().catch(error=>toast(error.message)),120);}
async function replay(){const data=await api('/events?limit=500');remember(data.events);renderChat();await refresh();}
function connect(){
  if(disposed)return;socket=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/events/live`);
  socket.onopen=()=>{live=true;reconnectDelay=1000;$('connection').textContent='● Conectado';$('connection').className='connection connected';void replay().catch(error=>toast(error.message));};
  socket.onmessage=event=>{try{remember([JSON.parse(event.data)]);renderChat();scheduleRefresh();}catch{}};
  socket.onclose=()=>{live=false;$('connection').textContent='Reconectando…';$('connection').className='connection';if(!disposed){reconnectTimer=setTimeout(connect,reconnectDelay);reconnectDelay=Math.min(reconnectDelay*2,10000);}};
  socket.onerror=()=>socket.close();
}
async function init(){
  try{const health=await api('/health');demo=health.mode==='demo';$('mode').textContent=demo?'DEMONSTRAÇÃO':'MODELOS REAIS';$('mode-banner').hidden=!demo;$('mode-banner').textContent='Modo demonstração: respostas fixas do Estúdio Aurora, arquivos e testes reais. Nenhum gasto com API.';$('briefing-hint').textContent=demo?'Nesta demonstração, qualquer briefing usa o exemplo fixo do Estúdio Aurora.':'Primeiro serviço disponível: landing page estática. As chamadas usarão os provedores configurados.';await replay();connect();}
  catch(error){$('connection').textContent='Sem conexão';toast(error.message);reconnectTimer=setTimeout(init,4000);}
}
renderDetails();renderChat();void init();
const refreshInterval=setInterval(()=>{if(!live)void replay().catch(()=>{});},15000);
window.addEventListener('pagehide',()=>{disposed=true;clearInterval(refreshInterval);clearTimeout(reconnectTimer);clearTimeout(refreshTimer);clearTimeout(toastTimer);socket?.close();office.stop();});
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
