export const team = [
  { role:'product_owner', name:'Nina', job:'Produto', color:'#c598b8', x:1.5, y:1.7 },
  { role:'tech_lead', name:'Atlas', job:'Planejamento', color:'#c9a66d', x:4.2, y:1.7 },
  { role:'web_dev', name:'Pixel', job:'Front-end', color:'#8faed2', x:6.9, y:1.7 },
  { role:'back_dev', name:'Rex', job:'Back-end', color:'#78b4ad', x:1.5, y:4.8 },
  { role:'fullstack_dev', name:'Juno', job:'Desenvolvimento', color:'#ad9ad9', x:4.2, y:4.8 },
  { role:'qa', name:'Vera', job:'Qualidade', color:'#9abc86', x:6.9, y:4.8 },
];

export function createOffice(canvas) {
  const c = canvas.getContext('2d');
  let roles = new Set(), stopped = false, frame, lastPaint=0;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  function point(x,y,z=0) { return [430+(x-y)*41,135+(x+y)*20.5-z]; }
  function polygon(points,color,stroke) {
    c.beginPath(); points.forEach(([x,y],i)=>i?c.lineTo(x,y):c.moveTo(x,y)); c.closePath();
    c.fillStyle=color; c.fill(); if(stroke){c.strokeStyle=stroke;c.lineWidth=1;c.stroke();}
  }
  function box(x,y,w,d,height,color,side='#30374c') {
    const a=point(x,y,height),b=point(x+w,y,height),e=point(x+w,y+d,height),f=point(x,y+d,height);
    polygon([b,e,point(x+w,y+d),point(x+w,y)],side);
    polygon([f,e,point(x+w,y+d),point(x,y+d)],'#293044');
    polygon([a,b,e,f],color);
  }
  function label(text,x,y,color='#c2c9db',size=11) { c.font=`${size}px Segoe UI, sans-serif`;c.fillStyle=color;c.textAlign='center';c.fillText(text,x,y); }
  function sprite(person,time) {
    const working=roles.has(person.role), [x,y]=point(person.x+.72,person.y+1.28);
    const bob=working&&!reduced.matches ? Math.round(Math.sin(time/220)*1.4):0;
    c.fillStyle='#10172688'; c.beginPath();c.ellipse(x,y+5,16,7,0,0,Math.PI*2);c.fill();
    const map=['..hhhh..','.hhhhhh.','.hsssssh','.hssessh','..ssss..','...ss...','..bbbb..','.bbbbbb.','ssbbbbss','..bbbb..','..pppp..','..pppp..','..p..p..','.kk..kk.'];
    const palette={h:'#343146',s:'#deb799',e:'#303044',b:person.color,p:'#4a526d',k:'#202637'};
    const s=3;
    for(let row=0;row<map.length;row++)for(let col=0;col<map[row].length;col++){
      const color=palette[map[row][col]];if(color){c.fillStyle=color;c.fillRect(Math.round(x-12+col*s),Math.round(y-39+row*s+bob),s,s);}
    }
    if(working){c.fillStyle='#bbaeeb';c.beginPath();c.arc(x+20,y-42,3,0,Math.PI*2);c.fill();label('trabalhando',x,y-58,'#cebdff',9);}
    label(person.name,x,y+22,working?'#ded0ff':'#a2adc7',11);
  }
  function plant(x,y){box(x,y,.35,.35,14,'#b59483');const p=point(x+.16,y+.16,18);c.fillStyle='#688f80';for(const [dx,dy]of[[-6,-9],[5,-12],[0,-20]]){c.fillRect(p[0]+dx-5,p[1]+dy,10,13);}}
  function draw(time){
    c.clearRect(0,0,900,490);
    c.fillStyle='#0b112455';c.beginPath();c.ellipse(450,343,325,86,0,0,Math.PI*2);c.fill();
    polygon([point(0,0),point(9,0),point(9,7),point(0,7)],'#30394d','#48526c');
    for(let x=0;x<9;x++)for(let y=0;y<7;y++)polygon([point(x,y),point(x+1,y),point(x+1,y+1),point(x,y+1)],(x+y)%2?'#30394d':'#333d52','#3e485e');
    polygon([point(0,0,78),point(9,0,78),point(9,0),point(0,0)],'#414a63');
    polygon([point(0,0,78),point(0,7,78),point(0,7),point(0,0)],'#353e55');
    polygon([point(0,0,79),point(9,0,79),point(9,0,73),point(0,0,73)],'#666585');
    polygon([point(0,0,79),point(0,7,79),point(0,7,73),point(0,0,73)],'#595d7b');
    for(const [x,y]of[[2,0],[5,0]]){
      polygon([point(x,y,62),point(x+1.8,y,62),point(x+1.8,y,25),point(x,y,25)],'#7c97ad','#a5bad0');
      polygon([point(x+.1,y,57),point(x+1.7,y,57),point(x+1.7,y,30),point(x+.1,y,30)],'#536c8a');
    }
    polygon([point(0,1,62),point(0,3,62),point(0,3,29),point(0,1,29)],'#cbc5bb');
    const board=point(0,2,40);label('JPX / FORGE',board[0],board[1],'#626174',10);
    for(const person of team){
      box(person.x,person.y,1.55,.82,27,'#696c87','#41455f');
      const [mx,my]=point(person.x+.65,person.y+.26,29);
      c.fillStyle='#222b42';c.fillRect(mx-15,my-27,32,22);c.fillStyle=roles.has(person.role)?'#b8a4ee':'#66859c';c.fillRect(mx-12,my-24,26,16);
      c.fillStyle='#ccd0ee';c.fillRect(mx-9,my-20,11,2);c.fillRect(mx-9,my-15,17,2);c.fillStyle='#282f44';c.fillRect(mx-2,my-5,5,7);
      box(person.x+.52,person.y+.85,.5,.42,10,'#535b77');
      sprite(person,time);
    }
    plant(.1,6.2);plant(8.3,.3);plant(8.1,6.1);
    box(.2,4.7,.45,.9,24,'#7f6e60');
    const coffee=point(.35,4.95,35);c.fillStyle='#cfb5a0';c.fillRect(coffee[0]-4,coffee[1],8,9);
    label('CONSTRUIR COM CLAREZA.',465,467,'#586780',9);
  }
  function loop(t){if(stopped)return;if(t-lastPaint>80){draw(t);lastPaint=t;}frame=requestAnimationFrame(loop);}
  frame=requestAnimationFrame(loop);
  return { update(active){roles=new Set(active);}, stop(){stopped=true;cancelAnimationFrame(frame);} };
}
