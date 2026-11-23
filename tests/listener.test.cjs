const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const builtHtml=fs.readFileSync('index.html','utf8');const inlineScript=[...builtHtml.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].find(s=>!s[1].includes('application/json'))[2];const core=inlineScript.split('// END CORE')[0];
const context=vm.createContext({console,crypto:require('node:crypto').webcrypto,Date,Math,Set});vm.runInContext(core,context);
const api=vm.runInContext('({validate,mergeDaily,parseDaily,audioPlan,wordKey})',context);
const publishedDaily=JSON.parse(fs.readFileSync('daily-materials.json','utf8'));
const daily={version:1,batches:[publishedDaily.batches[0]]};
const blank=()=>api.validate({version:1,lessons:[]});
let checks=0;function check(name,fn){fn();console.log('PASS '+name);checks++}
check('Fresh settings use 1x; Japanese speech is opt-in',()=>{const s=blank();assert.equal(s.settings.rate,1);assert.equal(s.settings.readJapanese,false)});
check('Legacy default migrates once, custom speeds are preserved',()=>{assert.equal(api.validate({version:1,lessons:[],settings:{rate:.85}}).settings.rate,1);assert.equal(api.validate({version:1,lessons:[],settings:{rate:.9}}).settings.rate,.9);assert.equal(api.validate({version:1,lessons:[],settings:{rate:.85,speedDefaultVersion:2}}).settings.rate,.85)});
check('Daily import adds five sentences and ten complete word entries',()=>{const s=blank();api.mergeDaily(s,daily);assert.equal(s.lessons.length,1);assert.equal(s.lessons[0].sentences.length,5);assert.equal(s.vocabulary.length,10);for(const w of s.vocabulary)for(const key of ['zh','pinyin','ja'])assert.ok(w[key]&&w.example[key])});
check('Repeated sync is idempotent; words deduplicate across later dates',()=>{const s=blank();api.mergeDaily(s,daily);api.mergeDaily(s,daily);assert.equal(s.lessons.length,1);assert.equal(s.vocabulary.length,10);const later=JSON.parse(JSON.stringify(daily));later.batches[0].date='2026-11-24';api.mergeDaily(s,later);assert.equal(s.lessons.length,2);assert.equal(s.vocabulary.length,10)});
check('Manual and backup vocabulary deduplicate normalized Chinese text',()=>{const w=daily.batches[0].vocabulary[0];const s=api.validate({version:1,lessons:[],vocabulary:[w,{...w,zh:' 效 率 '}]});assert.equal(s.vocabulary.length,1);api.mergeDaily(s,daily);assert.equal(s.vocabulary.length,10)});
check('A malformed later batch causes no partial data mutation',()=>{const s=blank(),bad=JSON.parse(JSON.stringify(daily));bad.batches.push({date:'wrong'});assert.throws(()=>api.mergeDaily(s,bad));assert.equal(s.lessons.length,0);assert.equal(s.vocabulary.length,0)});
check('Deleted daily entries do not return on next sync',()=>{const s=blank();s.hiddenDaily=['daily-2026-11-23'];s.hiddenWords=['效率'];api.mergeDaily(s,daily);assert.equal(s.lessons.length,0);assert.equal(s.vocabulary.length,9)});
check('Bilingual speech orders Chinese before Japanese and skips empty translations',()=>{const s={zh:'你好',ja:'こんにちは'};assert.equal(api.audioPlan(s,true).map(x=>x.lang).join(','),'zh-CN,ja-JP');assert.equal(api.audioPlan(s,false).length,1);assert.equal(api.audioPlan({...s,ja:'  '},true).length,1)});
check('Old backups without vocabulary still load',()=>{const s=api.validate({version:1,lessons:[{id:'old',title:'既存教材',sentences:[{zh:'你好'}]}]});assert.equal(s.lessons[0].sentences[0].zh,'你好');assert.equal(s.vocabulary.length,0)});
check('Different sources on the same date are imported independently',()=>{const s=blank(),extra=JSON.parse(JSON.stringify(daily));extra.batches[0].id='daily-chatgpt-2026-11-23';api.mergeDaily(s,daily);api.mergeDaily(s,extra);assert.equal(s.lessons.length,2);assert.equal(s.vocabulary.length,10);api.mergeDaily(s,extra);assert.equal(s.lessons.length,2)});
check('Published history has complete, nonduplicated vocabulary and valid source links',()=>{const parsed=api.parseDaily(publishedDaily);const words=parsed.flatMap(b=>b.vocabulary);const keys=words.map(w=>api.wordKey(w.zh));assert.equal(new Set(keys).size,keys.length);for(const w of words)assert.ok(w.example.zh.includes(w.zh));for(const b of parsed)if(b.id.startsWith('daily-chatgpt-'))assert.ok(b.sourceUrl.startsWith('https://chatgpt.com/share/'));const s=blank();api.mergeDaily(s,publishedDaily);api.mergeDaily(s,publishedDaily);assert.equal(s.lessons.length,parsed.length);assert.equal(s.vocabulary.length,words.length)});
check('All inline JavaScript and JSON in the built HTML parse',()=>{const html=fs.readFileSync('index.html','utf8');const scripts=[...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];assert.equal(scripts.length,3);for(const s of scripts){if(s[1].includes('application/json'))JSON.parse(s[2]);else new vm.Script(s[2])}assert.ok(html.includes('id="readJapanese"'));assert.ok(html.includes('id="wordsTab"'))});
function audioHarness(){
 const browser=inlineScript;
 const section=browser.slice(browser.indexOf('function stop('),browser.indexOf('function el('));
 const c=vm.createContext({console,Date,Math,Set,crypto:require('node:crypto').webcrypto});
 vm.runInContext(core,c);
 vm.runInContext(`
  let generation=0,timer=null,utterance=null,isPlaying=false,current=-1;
  const voices=[{lang:'zh-CN',voiceURI:'zh'}],jaVoices=[{lang:'ja-JP',voiceURI:'ja'}],supported=true;
  const queue=new Map(),spoken=[],messages=[];let nextTimer=1,completed=0;
  function setTimeout(fn){const id=nextTimer++;queue.set(id,fn);return id}function clearTimeout(id){queue.delete(id)}
  function say(s){messages.push(s)}
  const document={querySelectorAll:()=>[]};
  const store={settings:{rate:1,repeat:2,gap:1000,readJapanese:true}};
  const lesson=()=>({sentences:[{zh:'你好',ja:'こんにちは'},{zh:'谢谢',ja:'ありがとう'}]});
  class SpeechSynthesisUtterance{constructor(text){this.text=text}}
  const synth={cancel(){},speak(u){spoken.push(u)}};
  function tick(){const first=queue.entries().next().value;if(first){queue.delete(first[0]);first[1]()}}
 `+section,c);
 return {run:code=>vm.runInContext(code,c)};
}
check('Speech repeats Chinese/Japanese pairs in order using separate language voices',()=>{const h=audioHarness();h.run("runSpeech(audioPlan({zh:'你好',ja:'こんにちは'},true),2,'test',()=>completed++);tick()");assert.equal(h.run('spoken[0].lang'),'zh-CN');assert.equal(h.run('spoken[0].rate'),1);h.run('spoken[0].onend();tick()');assert.equal(h.run('spoken[1].lang'),'ja-JP');h.run('spoken[1].onend();tick();spoken[2].onend();tick();spoken[3].onend()');assert.equal(h.run('spoken.map(u=>u.lang).join(",")'),'zh-CN,ja-JP,zh-CN,ja-JP');assert.equal(h.run('completed'),1)});
check('Stop cancels pending translation and ignores stale speech callbacks',()=>{const h=audioHarness();h.run("runSpeech(audioPlan({zh:'你好',ja:'こんにちは'},true),1,'test',()=>completed++);tick();stop();spoken[0].onend();tick()");assert.equal(h.run('spoken.length'),1);assert.equal(h.run('completed'),0);assert.equal(h.run('queue.size'),0)});
check('Stopping during a sentence gap prevents continuous playback advancing',()=>{const h=audioHarness();h.run('store.settings.repeat=1;store.settings.readJapanese=false;play(0,true);tick();spoken[0].onend();stop();tick()');assert.equal(h.run('spoken.length'),1);assert.equal(h.run('current'),0)});
check('A speech error does not advance to Japanese or the next sentence',()=>{const h=audioHarness();h.run('store.settings.repeat=1;play(0,true);tick();spoken[0].onerror({error:"voice-unavailable"});tick()');assert.equal(h.run('spoken.length'),1);assert.equal(h.run('isPlaying'),false)});
console.log(`${checks} checks passed`);
