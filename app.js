
  'use strict';
  (() => {
    const DEFAULT_INV = { s6:10, s5:10, s4:1, s3:0, s1:'∞', encounters:14 };
    const STORAGE_KEY = 'mewtwo_state_v3';
    const STORAGE_SCHEMA = 3;
    const LEGACY_FIELD_MAP = Object.freeze({
      mewtwo_inventory: 'inventory',
      mewtwo_gauge: 'gauge',
      mewtwo_isChance: 'isChance',
      mewtwo_fedCount: 'fedCount',
      mewtwo_guaranteedCount: 'guaranteedCount',
      mewtwo_isFull: 'isFull',
      mewtwo_history: 'history',
      mewtwo_bonusUsedThisEncounter: 'bonusUsedThisEncounter',
      mewtwo_isPremium: 'isPremium',
      mewtwo_futureGuaranteeDetailEnabled: 'detailEnabled',
      mewtwo_futureGuarantees: 'futureGuarantees'
    });
    const clone = (v) => JSON.parse(JSON.stringify(v));
    const readJson = (key, fallback) => { try { const v=localStorage.getItem(key); return v===null ? fallback : JSON.parse(v); } catch { return fallback; } };
    const encounterCount = (value) => Math.max(0, Math.floor(Number(value) || 0));
    const normalizeFutureGuarantees = (schedule, encounters) => {
      const length = Math.max(0, encounterCount(encounters) - 1);
      const source = Array.isArray(schedule) ? schedule : [];
      return Array.from({ length }, (_, i) => Number(source[i]) === 2 ? 2 : 3);
    };
    const normalizeCount = (value, allowInfinity=false, max=Infinity) => {
      if (allowInfinity && value === '∞') return '∞';
      const n = Math.max(0, Math.floor(Number(value) || 0));
      return Math.min(n, max);
    };
    const normalizeInventory = (inventory, guaranteedCount) => {
      const source = inventory && typeof inventory === 'object' ? inventory : {};
      const normalized = {
        s6: normalizeCount(source.s6),
        s5: normalizeCount(source.s5),
        s4: normalizeCount(source.s4, false, 1),
        s3: normalizeCount(source.s3, true),
        s1: normalizeCount(source.s1, true),
        encounters: encounterCount(source.encounters)
      };
      if (Number(guaranteedCount) === 2) normalized.s4 = 0;
      return normalized;
    };
    const normalizeStoredState = (raw) => {
      const source = raw && typeof raw === 'object' ? raw : {};
      const guaranteedCount = Number(source.guaranteedCount) === 2 ? 2 : 3;
      const inventory = normalizeInventory(source.inventory ?? DEFAULT_INV, guaranteedCount);
      const gauge = source.gauge === '' ? '' : Math.min(30, Math.max(0, Math.floor(Number(source.gauge) || 0)));
      return {
        schemaVersion: STORAGE_SCHEMA,
        inventory,
        gauge,
        isChance: !!source.isChance,
        fedCount: Math.max(0, Math.floor(Number(source.fedCount) || 0)),
        guaranteedCount,
        isFull: !!source.isFull,
        history: Array.isArray(source.history) ? clone(source.history) : [],
        bonusUsedThisEncounter: !!source.bonusUsedThisEncounter,
        isPremium: source.isPremium === undefined ? true : !!source.isPremium,
        detailEnabled: !!source.detailEnabled,
        futureGuarantees: normalizeFutureGuarantees(source.futureGuarantees, inventory.encounters)
      };
    };
    const loadLegacyState = () => ({
      inventory: readJson('mewtwo_inventory', DEFAULT_INV),
      gauge: readJson('mewtwo_gauge', 0),
      isChance: readJson('mewtwo_isChance', false),
      fedCount: readJson('mewtwo_fedCount', 0),
      guaranteedCount: readJson('mewtwo_guaranteedCount', 3),
      isFull: readJson('mewtwo_isFull', false),
      history: readJson('mewtwo_history', []),
      bonusUsedThisEncounter: readJson('mewtwo_bonusUsedThisEncounter', false),
      isPremium: readJson('mewtwo_isPremium', true),
      detailEnabled: readJson('mewtwo_futureGuaranteeDetailEnabled', false),
      futureGuarantees: readJson('mewtwo_futureGuarantees', [])
    });
    const writeStoredState = (value) => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); return true; } catch { return false; } };
    const existingStoredState = readJson(STORAGE_KEY, null);
    let storedState = normalizeStoredState(existingStoredState && typeof existingStoredState === 'object' ? existingStoredState : loadLegacyState());
    writeStoredState(storedState);
    const load = (key, fallback) => {
      const field = LEGACY_FIELD_MAP[key];
      return field && Object.prototype.hasOwnProperty.call(storedState, field) ? clone(storedState[field]) : fallback;
    };
    const save = (key, value) => {
      const field = LEGACY_FIELD_MAP[key];
      if (!field) return;
      storedState = normalizeStoredState({ ...storedState, [field]: clone(value) });
      writeStoredState(storedState);
    };
    const initialInventory = load('mewtwo_inventory', DEFAULT_INV);
    const initialDetailEnabled = !!load('mewtwo_futureGuaranteeDetailEnabled', false);
    const initialFutureGuarantees = normalizeFutureGuarantees(load('mewtwo_futureGuarantees', []), initialInventory.encounters);

    const state = {
      inventory: initialInventory,
      formData: null,
      gauge: load('mewtwo_gauge', 0),
      isChance: load('mewtwo_isChance', false),
      fedCount: load('mewtwo_fedCount', 0),
      guaranteedCount: load('mewtwo_guaranteedCount', 3),
      isFull: load('mewtwo_isFull', false),
      history: load('mewtwo_history', []),
      bonusUsedThisEncounter: load('mewtwo_bonusUsedThisEncounter', false),
      isPremium: load('mewtwo_isPremium', true),
      detailEnabled: initialDetailEnabled,
      futureGuarantees: initialFutureGuarantees,
      formDetailEnabled: initialDetailEnabled,
      formFutureGuarantees: clone(initialFutureGuarantees),
      engine: { isCalculating:false, bestMove:{type:'計算中...',id:null,prob:0}, expectedTotal:'計算中...', routeData:{route:[],finalG:0} }
    };
    state.formData = clone(state.inventory);
    // 旧保存データ等にボーナスが残っていても、2枚保証では0へ正規化する。
    if (Number(state.guaranteedCount) === 2) {
      state.inventory = { ...state.inventory, s4: 0 };
      state.formData = { ...state.formData, s4: 0 };
      save('mewtwo_inventory', state.inventory);
    }

    const $ = (id) => document.getElementById(id);
    const els = Object.fromEntries(['gaugeInput','progressBar','resetGauge','chanceLabel','chanceToggle','guaranteeSelect','guaranteeTrigger','guaranteeTriggerText','guaranteeMenu','feedStatus','nextMove','detailCard','catchProb','route','resultArea','normalBtn','bigBtn','superBtn','fullBtn','fullMessage','passMessage','undoBtn','nextEncounterBtn','nextEncounterDialog','nextEncounterCancel','nextEncounterProceed','resetGaugeDialog','resetGaugeCancel','resetGaugeProceed','expectedTotal','expectBox','premiumToggle','premiumTrack','premiumLabel','inputList','applyWrap','applyBtn','futureDialog','futureDialogClose','futureDetailToggle','futureOffNote','futureScheduleWrap','futureScheduleList'].map(id=>[id,$(id)]));

    const ROWS = [
      {id:'s6', label:()=> 'ミュウツーサブレ (6)', inf:false},
      {id:'s5', label:()=> 'ハイパーサブレ (5)', inf:false},
      {id:'s4', label:()=> state.isPremium ? 'ボーナスサブレ+ (4)' : 'ボーナスサブレ (3)', inf:false, max:1},
      {id:'s3', label:()=> 'スーパーサブレ (3)', inf:true},
      {id:'s1', label:()=> 'ポケサブレ (1)', inf:true},
      {id:'encounters', label:()=> '残り出会い回数', inf:false}
    ];

    function buildRows() {
      els.inputList.innerHTML='';
      for (const row of ROWS) {
        const wrap=document.createElement('div'); wrap.className='input-row'; wrap.dataset.id=row.id;
        const labelHtml = row.id==='encounters'
          ? `<div class="input-label-group"><span class="input-label"></span><button id="futureDetailBtn" class="detail-settings-btn" type="button" aria-haspopup="dialog" aria-controls="futureDialog"><span>詳細</span><span class="detail-settings-dot" aria-hidden="true"></span></button></div>`
          : `<span class="input-label"></span>`;
        wrap.innerHTML=`${labelHtml}<div class="input-controls"><div class="inf-slot">${row.inf?'<button class="inf-btn" type="button">∞</button>':''}</div><div class="stepper"><button class="step-btn down" type="button">−</button><input class="count-input" inputmode="numeric" min="0" ${row.max!==undefined?`max="${row.max}"`:''}><button class="step-btn up" type="button">＋</button></div></div>`;
        const input=wrap.querySelector('.count-input'); input.type='number';
        if(row.id==='encounters') wrap.querySelector('#futureDetailBtn').addEventListener('click',openFutureDialog);
        wrap.querySelector('.down').addEventListener('click',()=>stepRow(row,-1));
        wrap.querySelector('.up').addEventListener('click',()=>stepRow(row,1));
        input.addEventListener('input',()=>changeForm(row,input.value));
        if(row.inf) wrap.querySelector('.inf-btn').addEventListener('click',()=>changeForm(row,state.formData[row.id]==='∞'?'0':'∞'));
        els.inputList.appendChild(wrap);
      }
    }

    function changeForm(row, value) {
      if (row.id === 's4' && Number(state.guaranteedCount) === 2) { state.formData.s4 = 0; render(); return; }
      if (value==='∞' && row.inf) state.formData[row.id]='∞';
      else if (value==='') state.formData[row.id]='';
      else {
        let n=parseInt(String(value).replace(/^0+(?=\d)/,''),10); if(!Number.isFinite(n)||n<0)n=0; if(row.max!==undefined)n=Math.min(row.max,n); state.formData[row.id]=n;
      }
      if(row.id==='encounters' && state.formData.encounters!=='') {
        state.formFutureGuarantees=normalizeFutureGuarantees(state.formFutureGuarantees,state.formData.encounters);
      }
      render();
    }
    function stepRow(row, delta) {
      if (row.id === 's4' && Number(state.guaranteedCount) === 2) { state.formData.s4 = 0; render(); return; }
      const v=state.formData[row.id]; if(v==='∞') return;
      let n=v===''?0:(parseInt(v,10)||0); n=Math.max(0,n+delta); if(row.max!==undefined)n=Math.min(row.max,n); state.formData[row.id]=n;
      if(row.id==='encounters') state.formFutureGuarantees=normalizeFutureGuarantees(state.formFutureGuarantees,n);
      render();
    }
    function setStateKey(key,value,storageKey){ state[key]=value; if(storageKey) save(storageKey,value); }
    const actualGauge=()=> state.gauge===''?0:(Number(state.gauge)||0);
    const modified=()=> JSON.stringify(state.inventory)!==JSON.stringify(state.formData)
      || state.detailEnabled!==state.formDetailEnabled
      || JSON.stringify(state.futureGuarantees)!==JSON.stringify(state.formFutureGuarantees);

    let worker=null, requestId=0;
    function stopWorker(){ if(worker){worker.terminate();worker=null;} }
    function recalc(){
      const rid=++requestId; stopWorker();
      const enc=Number(state.inventory.encounters)||0;
      if(enc<=0){ state.engine={isCalculating:false,bestMove:{type:'完了',id:null,prob:1},expectedTotal:'0.00',routeData:{route:[],finalG:actualGauge()}}; render(); return; }
      state.engine={...state.engine,isCalculating:true,bestMove:{type:'計算中...',id:null,prob:0}}; render();
      try {
        worker=new Worker('./solver-worker.js');
      } catch (error) {
        console.error(error);
        state.engine={isCalculating:false,bestMove:{type:'エラー',id:null,prob:0},expectedTotal:'0.00',routeData:{route:[],finalG:actualGauge()}};
        render();
        return;
      }
      worker.onmessage=(e)=>{
        if(rid!==requestId)return; const data=e.data||{};
        if(data.type==='error'){ console.error(data.message||'Worker calculation error'); state.engine={isCalculating:false,bestMove:{type:'エラー',id:null,prob:0},expectedTotal:'0.00',routeData:{route:[],finalG:actualGauge()}}; stopWorker(); render(); return; }
        const r=data.result;
        let best;
        if(state.isFull) best={type:'満腹 (逃走)',id:null,prob:0};
        else if(actualGauge()>=30) best={type:'完了',id:null,prob:1};
        else best=r.action?{type:r.action.name,id:r.action.id,prob:r.catchProb}:{type:'➔ 翌日へ (ストップ)',id:'pass',prob:0};
        state.engine={isCalculating:false,bestMove:best,expectedTotal:Number(r.ev).toFixed(2),routeData:{route:r.route||[],finalG:r.finalG}};
        stopWorker(); render();
      };
      worker.onerror=(e)=>{ if(rid!==requestId)return; console.error(e.message||e); state.engine={isCalculating:false,bestMove:{type:'エラー',id:null,prob:0},expectedTotal:'0.00',routeData:{route:[],finalG:actualGauge()}}; stopWorker(); render(); };
      worker.postMessage({type:'solve',requestId:rid,premium:state.isPremium,guaranteedCount:Number(state.guaranteedCount)||3,detailEnabled:!!state.detailEnabled,futureGuarantees:state.futureGuarantees,state:{gauge:actualGauge(),fedCount:Number(state.fedCount)||0,chance:!!state.isChance,encounters:enc,inventory:state.inventory,encounterEnded:state.isFull||actualGauge()>=30}});
    }

    function renderFutureDialog(){
      if(!els.futureDialog)return;
      state.formFutureGuarantees=normalizeFutureGuarantees(state.formFutureGuarantees,state.formData.encounters);
      els.futureDetailToggle.checked=!!state.formDetailEnabled;
      els.futureOffNote.hidden=!!state.formDetailEnabled;
      els.futureScheduleWrap.hidden=!state.formDetailEnabled;
      els.futureScheduleList.innerHTML='';
      if(!state.formDetailEnabled)return;
      const count=encounterCount(state.formData.encounters);
      if(count<=1){
        const note=document.createElement('p'); note.className='future-empty-note'; note.textContent='現在の遭遇より後の予定はありません。';
        els.futureScheduleList.appendChild(note);
        return;
      }
      state.formFutureGuarantees.forEach((value,index)=>{
        const row=document.createElement('div'); row.className='future-schedule-row';
        const name=document.createElement('span'); name.className='future-schedule-name'; name.textContent=index===0?'次回':`${index+2}回目`;
        const segment=document.createElement('div'); segment.className='future-segment'; segment.setAttribute('role','group'); segment.setAttribute('aria-label',`${name.textContent}の確定ライン`);
        for(const choice of [3,2]){
          const button=document.createElement('button'); button.type='button'; button.className=`future-choice${Number(value)===choice?' active':''}`; button.textContent=`${choice}枚`; button.setAttribute('aria-pressed',Number(value)===choice?'true':'false');
          button.addEventListener('click',()=>{ state.formFutureGuarantees[index]=choice; renderFutureDialog(); render(); });
          segment.appendChild(button);
        }
        row.append(name,segment); els.futureScheduleList.appendChild(row);
      });
    }
    function openFutureDialog(){
      renderFutureDialog();
      if(typeof els.futureDialog.showModal==='function') els.futureDialog.showModal();
      else els.futureDialog.setAttribute('open','');
    }
    function closeFutureDialog(){
      if(typeof els.futureDialog.close==='function') els.futureDialog.close();
      else els.futureDialog.removeAttribute('open');
    }

    function renderRoute(){
      els.route.innerHTML=''; const arr=state.engine.routeData.route||[];
      arr.forEach((step,i)=>{ const s=document.createElement('span');s.className='route-step';s.textContent=step;els.route.appendChild(s); if(i<arr.length-1){const a=document.createElement('span');a.className='route-arrow';a.textContent='➔';els.route.appendChild(a);} });
      const end=document.createElement('span');
      if(state.engine.routeData.finalG>=30){end.className='route-get';end.textContent='GET!';} else {end.className='route-next';end.textContent='➔ 翌日へ';}
      els.route.appendChild(end);
    }

    function render(){
      const g=actualGauge(), calc=state.engine.isCalculating;
      els.gaugeInput.value=state.gauge;
      els.progressBar.style.width=`${Math.min(30,g)/30*100}%`;
      const chanceDisabled=state.fedCount>0||g>=30||state.isFull||calc;
      els.chanceToggle.checked=!!state.isChance; els.chanceToggle.disabled=chanceDisabled; els.chanceLabel.classList.toggle('disabled',chanceDisabled);
      els.guaranteeSelect.value=String(state.guaranteedCount); els.guaranteeSelect.disabled=state.isFull||calc;
      if(els.guaranteeTrigger){
        const guaranteeDisabled=state.isFull||calc;
        els.guaranteeTrigger.disabled=guaranteeDisabled;
        els.guaranteeTriggerText.textContent=Number(state.guaranteedCount)===2?'2枚':'3枚 (通常)';
        if(guaranteeDisabled && !els.guaranteeMenu.hidden){ els.guaranteeMenu.hidden=true; els.guaranteeTrigger.setAttribute('aria-expanded','false'); }
        els.guaranteeMenu.querySelectorAll('.guarantee-option').forEach(option=>{ const active=Number(option.dataset.value)===Number(state.guaranteedCount); option.classList.toggle('active',active); option.setAttribute('aria-selected',active?'true':'false'); });
      }
      els.feedStatus.textContent=`現在 ${Number(state.fedCount)+1} 枚目（${state.fedCount>=state.guaranteedCount?'⚠️満腹リスクあり':'✅確定ライン'}）`;
      els.nextMove.textContent=state.isFull?'満腹 (逃走)':state.engine.bestMove.type; els.nextMove.classList.toggle('dim',calc);
      const actionable=!state.isFull&&state.engine.bestMove.type!=='完了'&&state.engine.bestMove.id&&state.engine.bestMove.id!=='pass';
      els.detailCard.hidden=!actionable; els.resultArea.hidden=!actionable;
      els.detailCard.classList.toggle('dim',calc); els.catchProb.textContent=`${(Number(state.engine.bestMove.prob)||0)*100>=0?((Number(state.engine.bestMove.prob)||0)*100).toFixed(1):'0.0'}%`; renderRoute();
      for(const b of [els.normalBtn,els.bigBtn,els.superBtn]){b.disabled=calc;b.classList.toggle('disabled',calc);b.classList.toggle('wait',calc);}
      const fullDisabled=calc||state.fedCount<state.guaranteedCount; els.fullBtn.disabled=fullDisabled; els.fullBtn.classList.toggle('disabled',fullDisabled); els.fullBtn.classList.toggle('wait',calc);
      els.fullMessage.hidden=!state.isFull; els.passMessage.hidden=state.isFull||state.engine.bestMove.id!=='pass';
      els.undoBtn.hidden=state.history.length===0; els.undoBtn.disabled=calc; els.undoBtn.classList.toggle('disabled',calc); els.undoBtn.classList.toggle('wait',calc);
      els.nextEncounterBtn.disabled=calc; els.nextEncounterBtn.classList.toggle('disabled',calc); els.nextEncounterBtn.classList.toggle('wait',calc);
      els.expectedTotal.textContent=state.engine.expectedTotal; els.expectBox.classList.toggle('dim',calc);
      els.premiumToggle.checked=!!state.isPremium; els.premiumToggle.disabled=calc; els.premiumTrack.classList.toggle('on',state.isPremium); els.premiumLabel.classList.toggle('on',state.isPremium);
      for(const row of ROWS){ const wrap=els.inputList.querySelector(`[data-id="${row.id}"]`); if(!wrap)continue; wrap.querySelector('.input-label').textContent=row.label(); const input=wrap.querySelector('.count-input'); const bonusLocked=row.id==='s4'&&Number(state.guaranteedCount)===2; const v=bonusLocked?0:state.formData[row.id]; input.type=v==='∞'?'text':'number'; input.readOnly=v==='∞'; input.disabled=bonusLocked; input.value=v==='∞'?'∞':v; const down=wrap.querySelector('.down'),up=wrap.querySelector('.up'); const n=v===''?0:(parseInt(v,10)||0); down.disabled=bonusLocked||v==='∞'||n<=0; up.disabled=bonusLocked||v==='∞'||(row.max!==undefined&&n>=row.max); }
      const futureDetailBtn=$('futureDetailBtn'); if(futureDetailBtn){ futureDetailBtn.classList.toggle('active',!!state.formDetailEnabled); futureDetailBtn.setAttribute('aria-label',state.formDetailEnabled?'将来の確定ライン詳細（有効）':'将来の確定ライン詳細'); }
      if(els.futureDialog&&els.futureDialog.open) renderFutureDialog();
      els.applyWrap.hidden=!modified(); els.applyBtn.disabled=calc; els.applyBtn.classList.toggle('disabled',calc); els.applyBtn.classList.toggle('wait',calc);
    }

    function pushHistory(){ state.history=[...state.history,{gauge:state.gauge,fedCount:state.fedCount,isChance:state.isChance,isFull:state.isFull,bonusUsedThisEncounter:state.bonusUsedThisEncounter,inventory:clone(state.inventory),formData:clone(state.formData)}]; save('mewtwo_history',state.history); }
    function handleThrow(multiplier){
      const id=state.engine.bestMove.id; if(!id||id==='pass'||state.engine.isCalculating)return; pushHistory();
      if(multiplier===0){ setStateKey('isFull',true,'mewtwo_isFull'); recalc(); return; }
      let m=multiplier; if(state.isChance&&multiplier===1)m=3;
      const val=id==='s6'?6:id==='s5'?5:id==='s4'?(state.isPremium?4:3):id==='s3'?3:1; const added=m===30?30:val*m;
      if(id==='s4'){ state.bonusUsedThisEncounter=true; save('mewtwo_bonusUsedThisEncounter',true); }
      if(state.inventory[id]!=='∞'){ const next=Math.max(0,(Number(state.inventory[id])||0)-1); state.inventory={...state.inventory,[id]:next}; state.formData={...state.formData,[id]:next}; save('mewtwo_inventory',state.inventory); }
      setStateKey('gauge',Math.min(30,actualGauge()+added),'mewtwo_gauge'); setStateKey('fedCount',Number(state.fedCount)+1,'mewtwo_fedCount'); setStateKey('isChance',false,'mewtwo_isChance'); recalc();
    }
    function undo(){ if(!state.history.length)return; const last=state.history[state.history.length-1]; state.history=state.history.slice(0,-1); save('mewtwo_history',state.history); state.gauge=last.gauge;state.fedCount=last.fedCount;state.isChance=last.isChance;state.isFull=!!last.isFull;state.bonusUsedThisEncounter=!!last.bonusUsedThisEncounter;state.inventory=last.inventory;state.formData=last.formData; if(Number(state.guaranteedCount)===2){state.inventory={...state.inventory,s4:0};state.formData={...state.formData,s4:0};} save('mewtwo_gauge',state.gauge);save('mewtwo_fedCount',state.fedCount);save('mewtwo_isChance',state.isChance);save('mewtwo_isFull',state.isFull);save('mewtwo_bonusUsedThisEncounter',state.bonusUsedThisEncounter);save('mewtwo_inventory',state.inventory);recalc(); }
    function openNextEncounterDialog(){
      if(typeof els.nextEncounterDialog.showModal==='function')els.nextEncounterDialog.showModal();
      else els.nextEncounterDialog.setAttribute('open','');
    }
    function closeNextEncounterDialog(){
      if(typeof els.nextEncounterDialog.close==='function')els.nextEncounterDialog.close();
      else els.nextEncounterDialog.removeAttribute('open');
    }
    function openResetGaugeDialog(){
      if(typeof els.resetGaugeDialog.showModal==='function')els.resetGaugeDialog.showModal();
      else els.resetGaugeDialog.setAttribute('open','');
    }
    function closeResetGaugeDialog(){
      if(typeof els.resetGaugeDialog.close==='function')els.resetGaugeDialog.close();
      else els.resetGaugeDialog.removeAttribute('open');
    }
    function resetGaugeState(){
      state.gauge=0;state.fedCount=0;state.isChance=false;state.isFull=false;state.history=[];
      save('mewtwo_gauge',0);save('mewtwo_fedCount',0);save('mewtwo_isChance',false);save('mewtwo_isFull',false);save('mewtwo_history',[]);recalc();
    }
    function proceedNextEncounter(){
      if(actualGauge()>=30){state.gauge=0;save('mewtwo_gauge',0);}
      const scheduledNext = state.detailEnabled && Number(state.futureGuarantees[0])===2 ? 2 : 3;
      state.fedCount=0;state.isChance=false;state.isFull=false;state.history=[];state.bonusUsedThisEncounter=false;
      save('mewtwo_fedCount',0);save('mewtwo_isChance',false);save('mewtwo_isFull',false);save('mewtwo_history',[]);save('mewtwo_bonusUsedThisEncounter',false);
      state.guaranteedCount=scheduledNext; save('mewtwo_guaranteedCount',scheduledNext);
      const next={...state.inventory};let e=parseInt(next.encounters,10)||0;if(e>0)next.encounters=e-1;next.s4=scheduledNext===2?0:1;
      state.futureGuarantees=normalizeFutureGuarantees(state.futureGuarantees.slice(1),next.encounters);
      state.formFutureGuarantees=clone(state.futureGuarantees);
      save('mewtwo_futureGuarantees',state.futureGuarantees);
      state.inventory=next;state.formData=clone(next);save('mewtwo_inventory',next);recalc();
    }
    function nextEncounter(){
      if(!state.isFull&&actualGauge()<30){openNextEncounterDialog();return;}
      proceedNextEncounter();
    }

    buildRows();
    els.nextEncounterCancel.addEventListener('click',closeNextEncounterDialog);
    els.nextEncounterProceed.addEventListener('click',()=>{closeNextEncounterDialog();proceedNextEncounter();});
    els.nextEncounterDialog.addEventListener('click',e=>{if(e.target===els.nextEncounterDialog)closeNextEncounterDialog();});
    els.resetGauge.addEventListener('click',openResetGaugeDialog);
    els.resetGaugeCancel.addEventListener('click',closeResetGaugeDialog);
    els.resetGaugeProceed.addEventListener('click',()=>{closeResetGaugeDialog();resetGaugeState();});
    els.resetGaugeDialog.addEventListener('click',e=>{if(e.target===els.resetGaugeDialog)closeResetGaugeDialog();});
    els.futureDialogClose.addEventListener('click',closeFutureDialog);
    els.futureDialog.addEventListener('click',e=>{if(e.target===els.futureDialog)closeFutureDialog();});
    els.futureDetailToggle.addEventListener('change',e=>{state.formDetailEnabled=!!e.target.checked;renderFutureDialog();render();});
    els.gaugeInput.addEventListener('input',e=>{const v=e.target.value;if(v==='')state.gauge='';else state.gauge=Math.min(30,Math.max(0,parseInt(v,10)||0));state.history=[];state.isFull=false;save('mewtwo_gauge',state.gauge);save('mewtwo_history',[]);save('mewtwo_isFull',false);recalc();});
    els.chanceToggle.addEventListener('change',e=>{state.isChance=e.target.checked;save('mewtwo_isChance',state.isChance);recalc();});
    const closeGuaranteeMenu=()=>{ if(!els.guaranteeMenu)return; els.guaranteeMenu.hidden=true; els.guaranteeTrigger.setAttribute('aria-expanded','false'); };
    els.guaranteeTrigger.addEventListener('click',()=>{ if(els.guaranteeTrigger.disabled)return; const opening=els.guaranteeMenu.hidden; els.guaranteeMenu.hidden=!opening; els.guaranteeTrigger.setAttribute('aria-expanded',opening?'true':'false'); });
    els.guaranteeMenu.querySelectorAll('.guarantee-option').forEach(option=>option.addEventListener('click',()=>{ closeGuaranteeMenu(); els.guaranteeSelect.value=option.dataset.value; els.guaranteeSelect.dispatchEvent(new Event('change',{bubbles:true})); els.guaranteeTrigger.focus(); }));
    document.addEventListener('click',e=>{ if(!els.guaranteeMenu.hidden && !e.target.closest('.guarantee-dropdown')) closeGuaranteeMenu(); });
    document.addEventListener('keydown',e=>{ if(e.key==='Escape' && !els.guaranteeMenu.hidden){ closeGuaranteeMenu(); els.guaranteeTrigger.focus(); } });
    els.guaranteeSelect.addEventListener('change',e=>{
      const previousGuaranteedCount=Number(state.guaranteedCount);
      state.guaranteedCount=Number(e.target.value);
      save('mewtwo_guaranteedCount',state.guaranteedCount);
      if(state.guaranteedCount===2){
        state.inventory={...state.inventory,s4:0};
        state.formData={...state.formData,s4:0};
        save('mewtwo_inventory',state.inventory);
      } else if(previousGuaranteedCount===2 && state.guaranteedCount===3 && !state.bonusUsedThisEncounter){
        state.inventory={...state.inventory,s4:1};
        state.formData={...state.formData,s4:1};
        save('mewtwo_inventory',state.inventory);
      }
      recalc();
    });
    els.premiumToggle.addEventListener('change',e=>{state.isPremium=e.target.checked;save('mewtwo_isPremium',state.isPremium);render();recalc();});
    els.normalBtn.addEventListener('click',()=>handleThrow(1)); els.bigBtn.addEventListener('click',()=>handleThrow(3)); els.superBtn.addEventListener('click',()=>handleThrow(30)); els.fullBtn.addEventListener('click',()=>handleThrow(0));
    els.undoBtn.addEventListener('click',undo); els.nextEncounterBtn.addEventListener('click',nextEncounter);
    els.applyBtn.addEventListener('click',()=>{
      const clean={...state.formData};for(const k of ['s6','s5','s4','s3','s1','encounters'])if(clean[k]==='')clean[k]=0;
      // 2枚保証ではボーナス無しを不変条件として再正規化する。
      if(Number(state.guaranteedCount)===2) clean.s4=0;
      const future=normalizeFutureGuarantees(state.formFutureGuarantees,clean.encounters);
      state.inventory=clean;state.formData=clone(clean);
      state.detailEnabled=!!state.formDetailEnabled;state.futureGuarantees=future;state.formFutureGuarantees=clone(future);
      save('mewtwo_inventory',clean);save('mewtwo_futureGuaranteeDetailEnabled',state.detailEnabled);save('mewtwo_futureGuarantees',future);recalc();
    });
    window.addEventListener('beforeunload',stopWorker);
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' })
          .then((registration) => registration.update())
          .catch((error) => {
            console.error('Service Worker registration failed:', error);
          });
      });
    }
    render(); recalc();
  })();

(() => {
    'use strict';
    const TIPS_SEEN_KEY = 'mewtwo_tips_seen_v1';
    const tipsBtn = document.getElementById('tipsBtn');
    const tipsDialog = document.getElementById('tipsDialog');
    const tipsClose = document.getElementById('tipsClose');
    if (!tipsBtn || !tipsDialog || !tipsClose) return;

    let seen = false;
    try { seen = localStorage.getItem(TIPS_SEEN_KEY) === '1'; } catch {}
    tipsBtn.classList.toggle('unseen', !seen);

    const markSeen = () => {
      tipsBtn.classList.remove('unseen');
      try { localStorage.setItem(TIPS_SEEN_KEY, '1'); } catch {}
    };
    const openTips = () => {
      markSeen();
      if (typeof tipsDialog.showModal === 'function') tipsDialog.showModal();
      else tipsDialog.setAttribute('open', '');
    };
    const closeTips = () => {
      if (typeof tipsDialog.close === 'function') tipsDialog.close();
      else tipsDialog.removeAttribute('open');
    };

    tipsBtn.addEventListener('click', openTips);
    tipsClose.addEventListener('click', closeTips);
    tipsDialog.addEventListener('click', (event) => {
      if (event.target === tipsDialog) closeTips();
    });
  })();
