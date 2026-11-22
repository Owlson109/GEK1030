/* GEK1030 live quiz. Times are assigned by Firebase on receipt. */
(() => {
  'use strict';
  const rounds = [
    {
      q: ['2020 年旺角的口罩隊伍中，陸婆婆得到甚麼幫助？', 'What help did Ms Luk receive in the Mong Kok mask queue?'],
      a: [['店員提前開門','A shop opened early'],['一位女士讓出購買籌號','A woman gave up her queue ticket'],['記者代她付款','A reporter paid for her masks'],['有人替她送貨','Someone delivered her order']], key: 1,
      why: ['讓籌把一次購買機會交給了未能取籌的長者。','Giving up the ticket gave an older shopper a chance to buy masks.']
    },
    {
      q: ['「惻隱之心，仁之端也」中的「端」是甚麼意思？','In Mencius, what does it mean to call compassion the beginning of benevolence?'],
      a: [['關懷是修養的起點','Care is a starting point for cultivation'],['惻隱只限於家人','Compassion applies only to relatives'],['一感動便已成聖','Feeling moved makes one a sage'],['善行必有回報','Every good deed earns a reward']], key: 0,
      why: ['看見別人的困難可以引發關懷，德性的養成還需要實踐。','Seeing distress can awaken concern. Developing virtue takes practice.']
    },
    {
      q: ['釣具公司派口罩的個案，最能說明哪一點？','What does the fishing tackle company’s mask distribution illustrate?'],
      a: [['先到先得必定公平','First come, first served is always fair'],['派發數量足以反映公平','The total number given proves fairness'],['所有排隊者能力相同','Everyone can queue equally easily'],['派發安排要顧及長者的體力','Distribution should account for older people’s stamina']], key: 3,
      why: ['即使有物資，長時間站立也可能令有需要的人難以領取。','A long wait on foot can make available supplies difficult to access.']
    },
    {
      q: ['哪個做法最貼近荀子「積善成德」的主張？','Which practice best reflects Xunzi’s account of building virtue?'],
      a: [['只在有人看見時行善','Help only when someone is watching'],['用一次捐贈判定人格','Judge character by one donation'],['在不同處境反覆反省和行善','Reflect and practise good conduct across situations'],['等待自己先成為聖人','Wait until one has become a sage']], key: 2,
      why: ['荀子用「積」說明德性在持續的學習與行動中形成。','For Xunzi, virtue takes shape through accumulated learning and action.']
    },
    {
      q: ['從口罩短缺的個案，可以得出哪個結論？','Which conclusion do the mask shortage cases support?'],
      a: [['所有援助者都讀過儒家經典','Every helper had studied Confucian texts'],['個人關懷與公平制度各有作用','Personal care and fair institutions both matter'],['個人善心足以穩定供應','Generosity alone ensures a stable supply'],['一次善行足以證明成聖','A single kind act proves sagehood']], key: 1,
      why: ['讓籌和送口罩能解眼前困難，持續取得必需品仍需制度保障。','A ticket or a mask can meet an immediate need. Reliable access also needs public provision.']
    }
  ];

  let context, state, uid, player, players = {}, activeGame, live = false;
  let db, api, identity, guestAuth, watcher, rosterWatcher, subscription = 0;
  let loaded = false, connected = false, busy = false, draft = '', issue = '', root;
  const pick = pair => pair[document.documentElement.lang === 'en' ? 1 : 0];
  const t = (zh,en) => pick([zh,en]);
  const roundIndex = () => Number(state?.round?.slice(1) || 0);
  const ref = path => api.ref(db, 'gek1030/quiz/' + path);
  const peoplePath = () => 'games/' + state.game + '/players';
  const timeText = ms => (ms / 1000).toFixed(2) + ' s';
  const node = (tag,text,cls) => {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (cls) el.className = cls;
    return el;
  };
  function button(text, fn, disabled=false) {
    const el = node('button',text);
    el.type = 'button';
    el.disabled = disabled || busy || !connected;
    el.onclick = () => perform(fn);
    return el;
  }
  async function perform(fn) {
    if (busy || !connected) return;
    busy = true; issue = ''; render();
    try { await fn(); }
    catch (e) {
      issue = String(e.code || e.message);
    } finally { busy = false; render(); }
  }
  function score(person) {
    let correct = 0, ms = 0;
    rounds.forEach((r,i) => {
      const id = 'r' + i, a = person.answers?.[id];
      if (a && a.choice === r.key && typeof state.starts?.[id] === 'number') {
        correct++;
        ms += Math.max(0, a.at - state.starts[id]);
      }
    });
    return {correct,ms};
  }
  function standings() {
    const entries = Object.values(players).filter(p=>p.name).map(p=>({...p,...score(p)}));
    entries.sort((a,b)=> b.correct-a.correct || a.ms-b.ms || a.name.localeCompare(b.name));
    entries.forEach((p,i)=>{
      const previous=entries[i-1];
      p.rank=previous && p.correct===previous.correct && p.ms===previous.ms ? previous.rank : i+1;
    });
    return entries;
  }
  let names = {}, namesWatcher, opening = false;
  function disconnectNames() { namesWatcher?.(); namesWatcher=null; names={}; }
  function showRoster(box, entries) {
    const list=node('ul',undefined,'lantern-roll');
    for(const name of entries) {
      const chip=node('li',name);
      chip.style.setProperty('--tone',String([...name].reduce((sum,c)=>sum+c.codePointAt(0),0)%46));
      list.append(chip);
    }
    box.append(list);
  }
  function openLobbyIfReady() {
    if (!live || !loaded || state || !connected || !context?.sharing || opening || issue) return;
    opening=true;
    advance('lobby').catch(e=>{issue=e.code || e.message; render();}).finally(()=>{opening=false;});
  }
  function watchPeople() {
    const host = context.presenter && context.sharing;
    const key = state?.game && (host || uid) ? state.game + ':' + (host ? 'host' : uid) : '';
    if (key === activeGame) return;
    activeGame = key; disconnectNames(); rosterWatcher?.(); rosterWatcher = null;
    players = {}; player = null;
    if (!key) return;
    rosterWatcher = api.onValue(ref(peoplePath() + (host ? '' : '/' + uid)), snap => {
      if (key !== activeGame) return;
      if (host) players = snap.val() || {}; else {
        player = snap.val();
        if (player?.name && !namesWatcher) {
          namesWatcher = api.onValue(ref('games/'+state.game+'/names'), list=>{
            if (key===activeGame) {names=list.val() || {};render();}
          }, err=>{if(key===activeGame){issue=err.code || err.message;render();}});
        }
      }
      render();
    }, err => { if (activeGame === key) { issue = err.code || err.message; render(); } });
  }
  async function attach() {
    if (!context?.api || !context.db || !live || watcher) return;
    const ticket = ++subscription;
    api = context.api;
    if (!context.presenter) {
      const base = 'https://www.gstatic.com/firebasejs/13.4.0/';
      const [apps, auth] = await Promise.all([import(base+'firebase-app.js'),import(base+'firebase-auth.js')]);
      if (ticket !== subscription || !live) return;
      const app = apps.getApps().find(a=>a.name==='gek-quiz-player') || apps.initializeApp(window.gekFirebaseConfig,'gek-quiz-player');
      identity = auth; guestAuth = auth.getAuth(app);
      await guestAuth.authStateReady();
      if (ticket !== subscription || !live) return;
      uid = guestAuth.currentUser?.uid;
      db = api.getDatabase(app);
    } else db = context.db;
    watcher = api.onValue(ref('control'), snap => {
      loaded=true; state=snap.val(); issue=''; watchPeople(); openLobbyIfReady(); render();
    }, err=>{issue=err.code || err.message;render();});
  }
  async function advance(phase) {
    const expected = state;
    const index = roundIndex();
    const game = phase==='lobby' ? api.push(ref('games')).key : expected.game;
    const result = await api.runTransaction(ref('control'), old => {
      if (old?.game !== expected?.game || old?.round !== expected?.round || old?.phase !== expected?.phase) return;
      if (phase==='lobby') return {game, round:'r0', phase};
      const round = phase==='open' && expected.phase==='review' ? 'r'+(index+1) : old.round;
      const next = {...old,phase,round};
      if (phase==='open') next.starts={...old.starts,[round]:api.serverTimestamp()};
      return next;
    },{applyLocally:false});
    if (!result.committed) throw new Error('ROUND_CHANGED');
  }
  async function join() {
    const name = draft.trim(), game = state.game;
    if (!name || [...name].length > 24) throw new Error('NAME_LENGTH');
    if (!guestAuth.currentUser) await identity.signInAnonymously(guestAuth);
    uid=guestAuth.currentUser.uid;
    await api.update(ref('games/'+game),{['players/'+uid+'/name']:name,['names/'+uid]:name});
    watchPeople();
  }
  function answer(index) {
    return api.set(ref(peoplePath()+'/'+uid+'/answers/'+state.round),{choice:index,at:api.serverTimestamp()});
  }
  function hostView(box) {
    if (!context.sharing) {
      box.append(node('p',t('請先按右上角「開始同步」並登入講者帳戶。','Select Start session and sign in as presenter.'))); return;
    }
    if (!state) {
      box.append(button(t('開放報名','Open registration'),()=>advance('lobby'))); return;
    }
    const people = standings();
    if (state.phase==='lobby') {
      box.append(node('h3',t('已加入','Joined')+' · '+people.length));
      if (people.length) showRoster(box,people.map(p=>p.name)); else box.append(node('p',t('等待第一盞名燈亮起…','Waiting for the first player…')));
      box.append(button(t('統一開始第一題','Start question 1 for everyone'),()=>advance('open'),!people.length));
      return;
    }
    if (state.phase==='finished' && people.length) {
      const winners=people.filter(p=>p.rank===1);
      const medal=node('div',undefined,'winner-banner');
      medal.append(node('small',t('榜首','First place')),node('strong',winners.map(p=>p.name).join(' · ')));
      box.append(medal);
    }
    if(state.phase==='review') {
      const chart=node('div',undefined,'quiz-chart');
      for(let i=0;i<4;i++) {
        const count=people.filter(p=>p.answers?.[state.round]?.choice===i).length;
        const line=node('div');line.append(node('b','ABCD'[i]),node('i'),node('span',String(count)));
        line.style.setProperty('--amount',String(count/Math.max(people.length,1)));chart.append(line);
      }
      box.append(node('h3',t('本題選項分布','Answer distribution')),chart);
    }
    if (state.phase==='open') {
      const count=people.filter(p=>p.answers?.[state.round]).length;
      const meter=node('div',undefined,'answer-meter');
      meter.append(node('strong',t('已交答案','Answers in')+'  '+count+' / '+people.length));
      const bar=node('progress');bar.max=Math.max(people.length,1);bar.value=count;meter.append(bar);box.append(meter);
    }
    if (state.phase==='open') box.append(button(t('收回答案並揭曉','Close answers and reveal'),()=>advance('review')));
    if (state.phase==='review') {
      const last=roundIndex()===rounds.length-1;
      box.append(button(last?t('公布總排名','Show final standings'):t('開始下一題','Start next question'),()=>advance(last?'finished':'open')));
    }
    if (state.phase==='finished') box.append(button(t('開放新一局報名','Open a new game'),()=>advance('lobby')));
    const table=node('table'), headers=node('tr');
    for(const h of [t('排名','Rank'),t('名稱','Name'),t('本題','This round'),t('答對','Correct'),t('答對總時間','Time on correct answers')]) headers.append(node('th',h));
    table.append(headers);
    for (const p of people) {
      const row=node('tr'), a=p.answers?.[state.round];
      const result=a ? ('ABCD'[a.choice]+' '+(a.choice===rounds[roundIndex()].key?'✓':'✗')+' · '+timeText(Math.max(0,a.at-state.starts[state.round]))) : t('未答','No answer');
      for(const value of [p.rank,p.name,result,p.correct,p.correct?timeText(p.ms):'—'])row.append(node('td',String(value)));
      table.append(row);
    }
    const scroll=node('div',undefined,'quiz-table'); scroll.append(table);box.append(scroll);
  }
  function viewerView(box) {
    if (!state) {box.append(node('p',t('等待講者開放報名。','Waiting for registration to open.')));return;}
    if (!player?.name && state.phase==='lobby') {
      const form=node('form'),label=node('label',t('你的顯示名稱','Your display name'));
      const input=node('input'); input.name='nickname'; input.autocomplete='nickname';input.maxLength=24;input.required=true;input.value=draft;
      input.oninput=()=>{draft=input.value;};label.append(input);form.append(label);
      const submit=node('button',t('加入遊戲','Join game'));submit.disabled=busy||!connected;form.append(submit);
      form.onsubmit=e=>{e.preventDefault();perform(join);};box.append(form);return;
    }
    if (!player?.name) {box.append(node('p',t('本局已開始，可觀看題目並等候下一局。','This game has started. Follow the questions and join the next game.')));return;}
    box.append(node('h3',player.name));
    if (state.phase==='lobby') {showRoster(box,Object.values(names));box.append(node('p',t('已加入，請等候講者統一開題。','You’re in. Waiting for the presenter to start.')));return;}
    const a=player.answers?.[state.round];
    if (state.phase==='open' && !a) {
      const options=node('div',undefined,'quiz-options');
      rounds[roundIndex()].a.forEach((pair,i)=>options.append(button('ABCD'[i]+'  '+pick(pair),()=>answer(i))));
      box.append(options);return;
    }
    if (state.phase==='open') box.append(node('p',t('已選 ','Submitted ' )+'ABCD'[a.choice]+t('，等待揭曉。','. Waiting for the reveal.')));
    else {
      const result=score(player);
      box.append(node('p',a?(a.choice===rounds[roundIndex()].key?t('本題答對 ✓','Correct ✓'):t('本題答錯 ✗','Incorrect ✗')):t('本題未作答','No answer this round')));
      box.append(node('p',t('累計答對 ','Correct answers: ')+result.correct+' / '+rounds.length+' · '+timeText(result.ms)));
    }
  }
  function lanternSky() {
    const sky=node('div',undefined,'lantern-sky');sky.setAttribute('aria-hidden','true');
    for(let i=0;i<8;i++){
      const lamp=node('i',undefined,'sky-lamp');lamp.style.setProperty('--x',(i*37%103)+'%');
      lamp.style.setProperty('--delay',(-i*1.73)+'s');lamp.style.setProperty('--size',(29+i%3*19)+'px');
      lamp.style.setProperty('--drop',(i%4*30)+'px');sky.append(lamp);
    }
    return sky;
  }
  function render() {
    if (!live || !root) return;
    const focused=root.querySelector('input')===document.activeElement, pos=focused?document.activeElement.selectionStart:0;
    const phase=state?.phase || 'lobby';
    root.dataset.phase=phase; root.dataset.role=context?.presenter?'host':'guest';
    const scene=phase+':'+roundIndex();
    const entering=root.dataset.scene!==scene;
    root.dataset.scene=scene;
    const content=node('div',undefined,'quiz-content'+(entering?' scene-enter':''));
    const art=root.querySelector('.lantern-sky') || lanternSky();
    const old=root.querySelector('.quiz-content');
    content.append(node('p','GEK1030  /  '+t('課堂問答','CLASS QUIZ'),'quiz-kicker'));
    const showQuestion=state && ['open','review'].includes(state.phase);
    const round=rounds[roundIndex()];
    if (showQuestion || phase==='finished') {
      const rail=node('div',undefined,'round-wick');rail.setAttribute('aria-hidden','true');
      rounds.forEach((_,i)=>rail.append(node('i',undefined,i<=roundIndex()?'lit':'')));content.append(rail);
    }
    content.append(node('h2',showQuestion?pick(round.q):state?.phase==='finished'?t('總排名','Final standings'):t('仁心燈會','Lanterns of Benevolence')));
    content.append(node('p',showQuestion?t('第 ','Question ')+(roundIndex()+1)+' / '+rounds.length:t('五題四選一。答對較多者優先，同分按答對題目的總耗時排名。','Five multiple-choice questions. Most correct answers wins. Ties are ranked by total time on correct answers.'),'quiz-intro'));
    if (showQuestion && (context?.presenter || state.phase==='review' || !player?.name)) {
      const options=node('div',undefined,'quiz-options');
      round.a.forEach((pair,i)=>options.append(node('div','ABCD'[i]+'  '+pick(pair),'quiz-option'+(state.phase==='review'&&i===round.key?' quiz-correct':''))));
      content.append(options);
    }
    if(state?.phase==='review')content.append(node('p','✓ '+pick(round.why),'quiz-reason'));
    if (!context?.db)content.append(node('p',t('正在連接遊戲…','Connecting to the game…')));
    else if(!loaded)content.append(node('p',t('等候遊戲資料…','Waiting for game data…')));
    else if(context.presenter)hostView(content);else viewerView(content);
    if (issue) {
      let msg=t('遊戲暫未能更新，請檢查連線、Firebase 規則及匿名登入設定。','Game update failed. Check the connection, database rules and anonymous sign-in.');
      if(issue==='NAME_LENGTH')msg=t('請輸入 1 至 24 個字元的名稱。','Enter a name of 1–24 characters.');
      content.append(node('p',msg+' ('+issue+')','quiz-error'));
    } else if(!connected && context)content.append(node('p',t('等待重新連線…','Waiting to reconnect…')));
    if (!art.parentElement) root.prepend(art);
    if (old) old.replaceWith(content); else root.append(content);
    if(focused){const i=root.querySelector('input');if(i){i.focus();i.setSelectionRange(pos,pos);}}
  }
  window.gekQuiz = {
    update(next) {
      const hostChanged=context?.sharing !== next.sharing;
      context=next;connected=next.connected;
      if(live) {if(hostChanged && watcher)watchPeople();openLobbyIfReady(); if (!watcher)attach().catch(e=>{issue=e.message;render();});render();}
    },
    page(n) {
      live=n===15; document.documentElement.toggleAttribute('data-quiz-active',live);
      if(!live){disconnectNames();loaded=false;state=null;players={};player=null;subscription++;watcher?.();rosterWatcher?.();watcher=null;rosterWatcher=null;activeGame=null;return;}
      root=document.querySelector('.deck > .quiz-slide .quiz-root');
      attach().catch(e=>{issue=e.message;render();});render();
    },
    render
  };
})();
