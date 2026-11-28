const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const builtHtml=fs.readFileSync('index.html','utf8');const inlineScript=[...builtHtml.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].find(s=>!s[1].includes('application/json'))[2];const core=inlineScript.split('// END CORE')[0];
const context=vm.createContext({console,crypto:require('node:crypto').webcrypto,Date,Math,Set});vm.runInContext(core,context);
const api=vm.runInContext('({validate,mergeDaily,parseDaily,audioPlan,wordKey,sentenceVocabulary})',context);
const publishedDaily=JSON.parse(fs.readFileSync('daily-materials.json','utf8'));
const daily={version:1,batches:[publishedDaily.batches[0]]};
const embeddedDaily=JSON.parse(fs.readFileSync('index.html','utf8').match(/<script id="initialDailyData" type="application\/json">([\s\S]*?)<\/script>/)[1]);
const sourceWordList=embeddedDaily.batches.find(b=>b.lessonVocabulary?.length===30).lessonVocabulary;
const blank=()=>api.validate({version:1,lessons:[]});
let checks=0;function check(name,fn){fn();console.log('PASS '+name);checks++}
check('Fresh settings use 1x; Japanese speech is opt-in',()=>{const s=blank();assert.equal(s.settings.rate,1);assert.equal(s.settings.readJapanese,false)});
check('Word-bank audio mode defaults safely and survives saved settings',()=>{assert.equal(blank().settings.wordAudioMode,'word');assert.equal(api.validate({version:1,lessons:[],settings:{wordAudioMode:'example'}}).settings.wordAudioMode,'example');assert.equal(api.validate({version:1,lessons:[],settings:{wordAudioMode:'invalid'}}).settings.wordAudioMode,'word')});
check('Legacy default migrates once, custom speeds are preserved',()=>{assert.equal(api.validate({version:1,lessons:[],settings:{rate:.85}}).settings.rate,1);assert.equal(api.validate({version:1,lessons:[],settings:{rate:.9}}).settings.rate,.9);assert.equal(api.validate({version:1,lessons:[],settings:{rate:.85,speedDefaultVersion:2}}).settings.rate,.85)});
check('Daily import adds five sentences and ten complete word entries',()=>{const s=blank();api.mergeDaily(s,daily);assert.equal(s.lessons.length,1);assert.equal(s.lessons[0].sentences.length,5);assert.equal(s.vocabulary.length,10);for(const w of s.vocabulary)for(const key of ['zh','pinyin','ja'])assert.ok(w[key]&&w.example[key])});
check('Repeated sync is idempotent; words deduplicate across later dates',()=>{const s=blank();api.mergeDaily(s,daily);api.mergeDaily(s,daily);assert.equal(s.lessons.length,1);assert.equal(s.vocabulary.length,10);const later=JSON.parse(JSON.stringify(daily));later.batches[0].date='2026-11-24';api.mergeDaily(s,later);assert.equal(s.lessons.length,2);assert.equal(s.vocabulary.length,10)});
check('Manual and backup vocabulary deduplicate normalized Chinese text',()=>{const w=daily.batches[0].vocabulary[0];const s=api.validate({version:1,lessons:[],vocabulary:[w,{...w,zh:' 效 率 '}]});assert.equal(s.vocabulary.length,1);api.mergeDaily(s,daily);assert.equal(s.vocabulary.length,10)});
check('A malformed later batch causes no partial data mutation',()=>{const s=blank(),bad=JSON.parse(JSON.stringify(daily));bad.batches.push({date:'wrong'});assert.throws(()=>api.mergeDaily(s,bad));assert.equal(s.lessons.length,0);assert.equal(s.vocabulary.length,0)});
check('Deleted daily entries do not return on next sync',()=>{const s=blank();s.hiddenDaily=['daily-2026-11-23'];s.hiddenWords=['效率'];api.mergeDaily(s,daily);assert.equal(s.lessons.length,0);assert.equal(s.vocabulary.length,9)});
check('Bilingual speech orders Chinese before Japanese and skips empty translations',()=>{const s={zh:'你好',ja:'こんにちは'};assert.equal(api.audioPlan(s,true).map(x=>x.lang).join(','),'zh-CN,ja-JP');assert.equal(api.audioPlan(s,false).length,1);assert.equal(api.audioPlan({...s,ja:'  '},true).length,1)});
check('Sentence explanations include matching words once, in reading order, with longer phrases first',()=>{const words=['重要','收入','不相关','收入增加','收 入'].map(zh=>({zh}));const result=api.sentenceVocabulary('收入增加以后，收入仍然重要。',words);assert.equal(result.map(w=>w.zh).join(','),'收入增加,收入,重要');assert.equal(result[1],words[1]);assert.equal(words.length,5)});
check('Sentence explanations normalize full-width text and whitespace, and handle unregistered sentences',()=>{const words=[{zh:'ＡＩ'},{zh:'收 入'},{zh:''}];assert.equal(api.sentenceVocabulary('AI 可以提高收入。',words).map(w=>w.zh).join(','),'ＡＩ,收 入');assert.equal(api.sentenceVocabulary('你好',words).length,0);assert.equal(api.sentenceVocabulary('',words).length,0)});
check('Old backups without vocabulary still load',()=>{const s=api.validate({version:1,lessons:[{id:'old',title:'既存教材',sentences:[{zh:'你好'}]}]});assert.equal(s.lessons[0].sentences[0].zh,'你好');assert.equal(s.vocabulary.length,0)});
check('Different sources on the same date are imported independently',()=>{const s=blank(),extra=JSON.parse(JSON.stringify(daily));extra.batches[0].id='daily-chatgpt-2026-11-23';api.mergeDaily(s,daily);api.mergeDaily(s,extra);assert.equal(s.lessons.length,2);assert.equal(s.vocabulary.length,10);api.mergeDaily(s,extra);assert.equal(s.lessons.length,2)});
check('Published history has complete, nonduplicated vocabulary and valid source links',()=>{const parsed=api.parseDaily(publishedDaily);const words=parsed.flatMap(b=>b.vocabulary);const keys=words.map(w=>api.wordKey(w.zh));assert.equal(new Set(keys).size,keys.length);for(const w of words)assert.ok(w.example.zh.includes(w.zh));for(const b of parsed)if(b.id.startsWith('daily-chatgpt-'))assert.ok(b.sourceUrl.startsWith('https://chatgpt.com/share/'));const s=blank();api.mergeDaily(s,publishedDaily);api.mergeDaily(s,publishedDaily);assert.equal(s.lessons.length,parsed.length);assert.equal(s.vocabulary.length,words.length)});
check('All inline JavaScript and JSON in the built HTML parse',()=>{const html=fs.readFileSync('index.html','utf8');const scripts=[...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];assert.equal(scripts.length,4);for(const s of scripts){if(s[1].includes('application/json'))JSON.parse(s[2]);else new vm.Script(s[2])}assert.ok(html.includes('id="readJapanese"'));assert.ok(html.includes('id="wordsTab"'))});
function audioHarness(requireGesture=false){
 const browser=inlineScript;
 const section=browser.slice(browser.indexOf('function stop('),browser.indexOf('function el('));
 const filterSection=browser.slice(browser.indexOf('function filteredWords('),browser.indexOf('function renderWords('));
 const testClock={now:1000};const c=vm.createContext({console,Date:class extends Date{static now(){return testClock.now}},Math,Set,crypto:require('node:crypto').webcrypto});
 vm.runInContext(core,c);
 vm.runInContext(`
  let generation=0,timer=null,utterance=null,playback=null,speechWait=null,isPlaying=false,isPaused=false,current=-1;
  const voices=[{lang:'zh-CN',voiceURI:'zh'}],jaVoices=[{lang:'ja-JP',voiceURI:'ja'}],supported=true;
  const queue=new Map(),spoken=[],messages=[];let nextTimer=1,completed=0,lastDelay=0,cancelled=0;
  function setTimeout(fn,delay){lastDelay=delay;const id=nextTimer++;queue.set(id,fn);return id}function clearTimeout(id){queue.delete(id)}
  function say(s){messages.push(s)}
  function updatePlaybackButtons(){}
  function stopScreenOffAudio(){}
  function showNowReading(){}
  function configureAudioSession(){}
  const document={querySelectorAll:()=>[]};
  const store={vocabulary:[],settings:{rate:1,repeat:2,gap:1000,readJapanese:true,wordAudioMode:'word'}};let testQuery='';const $=()=>({value:testQuery});
  const testLesson={sentences:[{zh:'你好',ja:'こんにちは'},{zh:'谢谢',ja:'ありがとう'}]};const lesson=()=>testLesson;
  class SpeechSynthesisUtterance{constructor(text){this.text=text}}
  let gestureActive=false,speechUnlocked=${!requireGesture};
  function tap(fn){gestureActive=true;try{fn()}finally{gestureActive=false}}
  let pausedCalls=0,resumedCalls=0;
  const synth={paused:false,pause(){this.paused=true;pausedCalls++},resume(){this.paused=false;resumedCalls++},cancel(){cancelled++},speak(u){if(gestureActive)speechUnlocked=true;if(speechUnlocked)spoken.push(u)}};
  function tick(){const first=queue.entries().next().value;if(first){queue.delete(first[0]);first[1]()}}
 `+section+filterSection,c);
 return {run:code=>vm.runInContext(code,c),advance:ms=>{testClock.now+=ms}};
}
check('Safari starts sentence speech in the tap and continues after the gesture ends',()=>{const h=audioHarness(true);h.run('store.settings.repeat=1;tap(()=>play(0,true));tick()');assert.equal(h.run('spoken.length'),1);h.run('spoken[0].onend();tick()');assert.equal(h.run('spoken[1].lang'),'ja-JP');h.run('spoken[1].onend();tick()');assert.equal(h.run('current'),1);assert.equal(h.run('spoken[2].text'),'谢谢')});
check('Safari starts standalone Japanese, vocabulary and example speech in the tap',()=>{for(const translationOnly of [false,true]){const h=audioHarness(true);h.run(`tap(()=>playText({zh:'你好',ja:'こんにちは'},'test',${translationOnly}));tick()`);assert.equal(h.run('spoken.length'),1);assert.equal(h.run('spoken[0].lang'),translationOnly?'ja-JP':'zh-CN')}});
check('Full-text playback starts in the Safari tap and reads all Chinese once regardless of sentence settings',()=>{const h=audioHarness(true);h.run('store.settings.repeat=5;store.settings.rate=.9;tap(()=>playFullText())');assert.equal(h.run('spoken[0].text'),'你好');assert.equal(h.run('spoken[0].rate'),.9);h.run('spoken[0].onend();tick()');assert.equal(h.run('spoken.map(u=>u.text).join(",")'),'你好,谢谢');assert.equal(h.run('spoken.every(u=>u.lang==="zh-CN")'),true);h.run('spoken[1].onend();tick()');assert.equal(h.run('spoken.length'),2);assert.equal(h.run('isPlaying'),false);assert.equal(h.run('messages.at(-1)'),'中国語全文の再生が終わりました。')});
check('Stopping full text cancels its next sentence and replay starts from the beginning',()=>{const h=audioHarness(true);h.run('tap(()=>playFullText());spoken[0].onend();stop();tick()');assert.equal(h.run('spoken.length'),1);h.run('tap(()=>playFullText());spoken[0].onend();tick()');assert.equal(h.run('spoken.length'),2);assert.equal(h.run('spoken[1].text'),'你好');assert.equal(h.run('current'),-1)});
check('Speech repeats Chinese/Japanese pairs in order using separate language voices',()=>{const h=audioHarness();h.run("runSpeech(audioPlan({zh:'你好',ja:'こんにちは'},true),2,'test',()=>completed++);tick()");assert.equal(h.run('spoken[0].lang'),'zh-CN');assert.equal(h.run('spoken[0].rate'),1);h.run('spoken[0].onend();tick()');assert.equal(h.run('spoken[1].lang'),'ja-JP');h.run('spoken[1].onend();tick();spoken[2].onend();tick();spoken[3].onend()');assert.equal(h.run('spoken.map(u=>u.lang).join(",")'),'zh-CN,ja-JP,zh-CN,ja-JP');assert.equal(h.run('completed'),1)});
check('Stop cancels pending translation and ignores stale speech callbacks',()=>{const h=audioHarness();h.run("runSpeech(audioPlan({zh:'你好',ja:'こんにちは'},true),1,'test',()=>completed++);tick();stop();spoken[0].onend();tick()");assert.equal(h.run('spoken.length'),1);assert.equal(h.run('completed'),0);assert.equal(h.run('queue.size'),0)});
check('Stopping during a sentence gap prevents continuous playback advancing',()=>{const h=audioHarness();h.run('store.settings.repeat=1;store.settings.readJapanese=false;play(0,true);tick();spoken[0].onend();stop();tick()');assert.equal(h.run('spoken.length'),1);assert.equal(h.run('current'),0)});
check('A speech error does not advance to Japanese or the next sentence',()=>{const h=audioHarness();h.run('store.settings.repeat=1;play(0,true);tick();spoken[0].onerror({error:"voice-unavailable"});tick()');assert.equal(h.run('spoken.length'),1);assert.equal(h.run('isPlaying'),false)});
check('Speed changes resume at cumulative word offsets and ignore canceled utterance callbacks',()=>{const h=audioHarness(true);h.run("testLesson.sentences[0].zh='你好世界';tap(()=>playFullText());spoken[0].onstart();spoken[0].onboundary({charIndex:2});store.settings.rate=1.2;tap(()=>applySpeechSetting('rate'))");assert.equal(h.run('spoken[1].text'),'世界');assert.equal(h.run('spoken[1].rate'),1.2);h.run('spoken[0].onend();spoken[0].onerror({error:"canceled"})');assert.equal(h.run('spoken.length'),2);assert.equal(h.run('isPlaying'),true);h.run("spoken[1].onstart();spoken[1].onboundary({charIndex:1});store.settings.rate=.8;tap(()=>applySpeechSetting('rate'))");assert.equal(h.run('spoken[2].text'),'界');h.run('spoken[2].onend();tick()');assert.equal(h.run('spoken[3].text'),'谢谢');h.run('spoken[3].onend()');assert.equal(h.run('isPlaying'),false)});
check('Voices without word positions finish the current sentence and use new settings on the next one',()=>{const h=audioHarness();h.run("playFullText();spoken[0].onstart();store.settings.rate=.7;applySpeechSetting('rate')");assert.equal(h.run('spoken.length'),1);assert.equal(h.run('cancelled'),1);assert.equal(h.run('isPlaying'),true);h.run('spoken[0].onend();tick()');assert.equal(h.run('spoken[1].text'),'谢谢');assert.equal(h.run('spoken[1].rate'),.7)});
check('A replacement voice must report fresh progress before another in-sentence restart',()=>{const h=audioHarness();h.run("testLesson.sentences[0].zh='你好世界';playFullText();spoken[0].onboundary({charIndex:2});store.settings.rate=1.2;applySpeechSetting('rate');spoken[1].onstart();store.settings.rate=.9;applySpeechSetting('rate')");assert.equal(h.run('spoken.length'),2);h.run('spoken[1].onend();tick()');assert.equal(h.run('spoken[2].text'),'谢谢');assert.equal(h.run('spoken[2].rate'),.9)});
check('Display settings never interrupt an active utterance',()=>{const h=audioHarness();h.run("play(0);spoken[0].onstart();store.settings.showPinyin=false;applySpeechSetting('showPinyin');store.settings.showJa=false;applySpeechSetting('showJa')");assert.equal(h.run('spoken.length'),1);assert.equal(h.run('cancelled'),1);assert.equal(h.run('isPlaying'),true)});
check('Japanese narration and repeat changes apply at speech boundaries without losing the current sentence',()=>{const h=audioHarness();h.run("store.settings.readJapanese=false;play(0);spoken[0].onstart();store.settings.readJapanese=true;applySpeechSetting('readJapanese');store.settings.repeat=1;applySpeechSetting('repeat');spoken[0].onend();tick()");assert.equal(h.run('spoken[1].lang'),'ja-JP');h.run('spoken[1].onend();tick()');assert.equal(h.run('spoken.length'),2);assert.equal(h.run('isPlaying'),false);const off=audioHarness();off.run("store.settings.repeat=1;play(0);spoken[0].onend();store.settings.readJapanese=false;applySpeechSetting('readJapanese');tick()");assert.equal(off.run('spoken.length'),1);assert.equal(off.run('isPlaying'),false)});
check('Japanese voice changes resume the Japanese text with the chosen voice',()=>{const h=audioHarness();h.run("store.settings.repeat=1;play(0);spoken[0].onend();tick();spoken[1].onboundary({charIndex:2});jaVoices.push({lang:'ja-JP',voiceURI:'ja2'});store.settings.jaVoice='ja2';applySpeechSetting('jaVoice')");assert.equal(h.run('spoken[2].text'),'にちは');assert.equal(h.run('spoken[2].voice.voiceURI'),'ja2');assert.equal(h.run('spoken[2].rate'),1)});
check('Changing gaps repeatedly preserves elapsed waiting time and the next sentence',()=>{const h=audioHarness();h.run('store.settings.repeat=1;store.settings.readJapanese=false;play(0,true);spoken[0].onend()');h.advance(400);h.run("store.settings.gap=2000;applySpeechSetting('gap')");assert.equal(h.run('lastDelay'),1600);h.advance(300);h.run("store.settings.gap=1000;applySpeechSetting('gap')");assert.equal(h.run('lastDelay'),300);h.run('tick()');assert.equal(h.run('spoken[1].text'),'谢谢');assert.equal(h.run('current'),1)});
check('Safari reads all thirty source words Chinese then Japanese once even when sentence translation is off',()=>{const h=audioHarness(true);h.run(`testLesson.lessonVocabulary=${JSON.stringify(sourceWordList)};store.settings.readJapanese=false;store.settings.repeat=5;store.settings.rate=.8;tap(()=>playLessonVocabulary())`);assert.equal(h.run('spoken.length'),1);for(let i=0;i<60;i++){assert.equal(h.run(`spoken[${i}].text`),i%2?sourceWordList[Math.floor(i/2)].ja:sourceWordList[Math.floor(i/2)].zh);assert.equal(h.run(`spoken[${i}].lang`),i%2?'ja-JP':'zh-CN');assert.equal(h.run(`spoken[${i}].rate`),i%2?1:.8);h.run(`spoken[${i}].onend();tick()`)}assert.equal(h.run('spoken.length'),60);assert.equal(h.run('isPlaying'),false);assert.equal(h.run('queue.size'),0)});
check('Word bank switches from words to bilingual examples at the next word without interrupting the current pair',()=>{const h=audioHarness(true);h.run(`store.vocabulary=${JSON.stringify(daily.batches[0].vocabulary.slice(0,3))};store.settings.readJapanese=false;tap(()=>playWordBank());store.settings.wordAudioMode='example';spoken[0].onend();tick()`);const words=daily.batches[0].vocabulary;assert.equal(h.run('spoken[1].text'),words[0].ja);h.run('spoken[1].onend();tick()');assert.equal(h.run('spoken[2].text'),words[1].example.zh);h.run("store.settings.wordAudioMode='word';spoken[2].onend();tick()");assert.equal(h.run('spoken[3].text'),words[1].example.ja);h.run('spoken[3].onend();tick()');assert.equal(h.run('spoken[4].text'),words[2].zh)});
check('Word-bank search playback includes every matching page in displayed date order',()=>{const h=audioHarness(true);h.run(`store.vocabulary=Array.from({length:45},(_,i)=>({zh:'词'+i,pinyin:'cí',ja:i===44?'対象外':'対象',date:i%2?'2026-11-24':'2026-11-23',example:{zh:'例文'+i,ja:'訳'+i}}));testQuery='対象';store.vocabulary[44].ja='別';store.settings.wordAudioMode='example';tap(()=>playWordBank())`);for(let i=0;i<88;i++)h.run(`spoken[${i}].onend();tick()`);assert.equal(h.run('spoken.length'),88);assert.equal(h.run('spoken[0].text'),'例文1');assert.equal(h.run('spoken[42].text'),'例文43');assert.equal(h.run('spoken[44].text'),'例文0');assert.equal(h.run('spoken.at(-1).text'),'訳42');assert.equal(h.run('isPlaying'),false)});
check('Stopping bilingual sequences cancels translation or the next word, ignores stale callbacks, and replay starts first',()=>{for(const betweenWords of [false,true]){const h=audioHarness(true);h.run('testLesson.lessonVocabulary=[{zh:"甲",ja:"一"},{zh:"乙",ja:"二"}];tap(()=>playLessonVocabulary());spoken[0].onend()');if(betweenWords)h.run('tick();spoken[1].onend()');const count=h.run('spoken.length');h.run('stop();spoken[0].onend();tick()');assert.equal(h.run('spoken.length'),count);assert.equal(h.run('isPlaying'),false);h.run('tap(()=>playLessonVocabulary())');assert.equal(h.run('spoken.at(-1).text'),'甲')}});
check('Sequence speed changes preserve word progress, Japanese translation, and the gap to the next word',()=>{const h=audioHarness(true);h.run('testLesson.lessonVocabulary=[{zh:"你好世界",ja:"こんにちは世界"},{zh:"谢谢",ja:"ありがとう"}];tap(()=>playLessonVocabulary());spoken[0].onboundary({charIndex:2});store.settings.rate=.75;tap(()=>applySpeechSetting("rate"));spoken[0].onend()');assert.equal(h.run('spoken[1].text'),'世界');h.run('spoken[1].onend();tick()');assert.equal(h.run('spoken[2].text'),'こんにちは世界');h.run('spoken[2].onend()');assert.equal(h.run('lastDelay'),1000);h.advance(400);h.run('store.settings.gap=2000;applySpeechSetting("gap")');assert.equal(h.run('lastDelay'),1600);h.run('tick()');assert.equal(h.run('spoken[3].text'),'谢谢');assert.equal(h.run('spoken[3].rate'),.75)});
check('Every lesson retains its complete source word list while the word bank stays deduplicated',()=>{const s=blank(),payload=JSON.parse(JSON.stringify(daily));payload.batches[0].lessonVocabulary=sourceWordList;payload.batches.push({...payload.batches[0],date:'2026-11-24',id:'another-source'});api.mergeDaily(s,payload);assert.equal(s.lessons.length,2);assert.equal(s.lessons[0].lessonVocabulary.length,30);assert.equal(s.lessons[1].lessonVocabulary.length,30);assert.equal(s.vocabulary.length,10);assert.equal(s.lessons[0].lessonVocabulary.map(w=>w.zh).join(','),sourceWordList.map(w=>w.zh).join(','));for(const w of s.lessons[0].lessonVocabulary)assert.ok(w.pinyin&&w.ja)});
check('Source list backfills update saved lessons without replacing manual edits or being downgraded by legacy sync',()=>{const s=blank();api.mergeDaily(s,daily);s.lessons[0].title='手動の教材名';s.lessons[0].sentences[0].zh='手動の文';const payload=JSON.parse(JSON.stringify(daily));payload.batches[0].lessonVocabulary=sourceWordList;const result=api.mergeDaily(s,payload);assert.equal(result.updatedLessons,1);assert.equal(result.addedLessons,0);assert.equal(result.addedWords,0);assert.equal(s.lessons[0].title,'手動の教材名');assert.equal(s.lessons[0].sentences[0].zh,'手動の文');assert.equal(api.mergeDaily(s,payload).updatedLessons,0);api.mergeDaily(s,daily);assert.equal(s.lessons[0].lessonVocabulary.length,30);const restored=api.validate(JSON.parse(JSON.stringify(s)));assert.equal(JSON.stringify(restored.lessons[0].lessonVocabulary),JSON.stringify(sourceWordList))});
check('Malformed source word lists cannot cause partial imports',()=>{const s=blank(),bad=JSON.parse(JSON.stringify(daily));bad.batches[0].lessonVocabulary=[{zh:'收入',pinyin:'',ja:'収入'}];assert.throws(()=>api.mergeDaily(s,bad));assert.equal(s.lessons.length,0);assert.equal(s.vocabulary.length,0)});
check('Published source lists keep thirty words each when supplied by the importer',()=>{for(const b of publishedDaily.batches){if(!b.id?.startsWith('daily-chatgpt-')||!b.lessonVocabulary)continue;assert.equal(b.lessonVocabulary.length,30);assert.equal(new Set(b.lessonVocabulary.map(w=>api.wordKey(w.zh))).size,30);for(const w of b.lessonVocabulary)assert.ok(w.zh&&w.pinyin&&w.ja)}});
check('Pause and resume retain the same utterance and then continue Chinese/Japanese playback',()=>{const h=audioHarness(true);h.run('store.settings.repeat=1;tap(()=>play(0));spoken[0].onstart();pauseSpeech();tick()');assert.equal(h.run('isPaused'),true);assert.equal(h.run('isPlaying'),true);assert.equal(h.run('synth.paused'),true);assert.equal(h.run('spoken.length'),1);h.run('tap(resumeSpeech)');assert.equal(h.run('isPaused'),false);assert.equal(h.run('spoken.length'),1);assert.equal(h.run('pausedCalls'),1);assert.equal(h.run('resumedCalls'),1);h.run('spoken[0].onend();tick()');assert.equal(h.run('spoken[1].text'),'こんにちは')});
check('Pause freezes the remaining delay between Chinese and Japanese, including a late end event',()=>{const h=audioHarness();h.run('store.settings.repeat=1;play(0);spoken[0].onend()');h.advance(100);h.run('pauseSpeech()');h.advance(10000);h.run('tick()');assert.equal(h.run('spoken.length'),1);h.run('resumeSpeech()');assert.equal(h.run('lastDelay'),200);h.run('tick()');assert.equal(h.run('spoken[1].lang'),'ja-JP');const late=audioHarness();late.run('store.settings.repeat=1;play(0);pauseSpeech();spoken[0].onend();tick()');assert.equal(late.run('spoken.length'),1);late.run('resumeSpeech();tick()');assert.equal(late.run('spoken[1].lang'),'ja-JP')});
check('Paused word gaps exclude paused time when the interval setting changes repeatedly',()=>{const h=audioHarness();h.run('testLesson.lessonVocabulary=[{zh:"甲",ja:"一"},{zh:"乙",ja:"二"}];playLessonVocabulary();spoken[0].onend();tick();spoken[1].onend()');h.advance(400);h.run('pauseSpeech()');h.advance(9000);h.run('store.settings.gap=2000;applySpeechSetting("gap");tick()');assert.equal(h.run('spoken.length'),2);assert.equal(h.run('speechWait.remaining'),1600);h.advance(5000);h.run('store.settings.gap=1000;applySpeechSetting("gap");resumeSpeech()');assert.equal(h.run('lastDelay'),600);h.run('tick()');assert.equal(h.run('spoken[2].text'),'乙')});
check('Speed changes while paused wait for resume and keep the word offset and translation',()=>{const h=audioHarness(true);h.run('testLesson.sentences[0].zh="你好世界";store.settings.repeat=1;tap(()=>play(0));spoken[0].onboundary({charIndex:2});pauseSpeech();store.settings.rate=.7;applySpeechSetting("rate")');assert.equal(h.run('spoken.length'),1);assert.equal(h.run('cancelled'),1);h.run('tap(resumeSpeech)');assert.equal(h.run('spoken[1].text'),'世界');assert.equal(h.run('spoken[1].rate'),.7);assert.equal(h.run('synth.paused'),false);h.run('spoken[0].onend();spoken[1].onend();tick()');assert.equal(h.run('spoken[2].lang'),'ja-JP')});
check('Stop while paused clears pause state, cancels pending work, and a new play starts normally',()=>{const h=audioHarness(true);h.run('tap(playFullText);pauseSpeech();stop();spoken[0].onend();tick()');assert.equal(h.run('isPaused'),false);assert.equal(h.run('isPlaying'),false);assert.equal(h.run('synth.paused'),false);assert.equal(h.run('spoken.length'),1);h.run('tap(playFullText)');assert.equal(h.run('spoken[1].text'),'你好');assert.equal(h.run('isPlaying'),true);const gap=audioHarness();gap.run('play(0);spoken[0].onend();pauseSpeech();stop();resumeSpeech();tick()');assert.equal(gap.run('spoken.length'),1)});
check('The word bank grows beyond five hundred and later daily imports remain deduplicated',()=>{const s=blank(),seed=daily.batches[0].vocabulary[0];s.vocabulary=Array.from({length:500},(_,i)=>({...seed,id:String(i),zh:'词'+i}));const later=JSON.parse(JSON.stringify(daily));later.batches[0].date='2026-11-24';later.batches[0].id='future-growth';later.batches[0].vocabulary=[s.vocabulary[0],{zh:'新词',pinyin:'xīn cí',ja:'新しい単語',example:{zh:'这是新词。',pinyin:'Zhè shì xīn cí.',ja:'これは新しい単語です。'}}];const result=api.mergeDaily(s,later);assert.equal(result.addedWords,1);assert.equal(s.vocabulary.length,501);assert.equal(api.mergeDaily(s,later).addedWords,0);assert.equal(s.vocabulary.length,501)});
function publishedAudioHarness(userAgent = 'iPhone') {
 const browser = inlineScript;
 const source = browser.slice(browser.indexOf('const screenOffPlayer ='), browser.indexOf('function renderLessonVocabulary('));
 const context = vm.createContext({TextEncoder,Blob,URL, navigator:{userAgent}, location:{protocol:'https:'}});
 vm.runInContext(`
  const rows=[{zh:'你好',ja:'こんにちは'},{zh:'再见',ja:'さようなら'}];
  const chinese='111111111111111111111111.mp3', bilingual='222222222222222222222222.mp3';
  const settings={rate:.8,readJapanese:false,wordAudioMode:'word',repeat:1,gap:1000},store={settings};
  const events={},messages=[],calls=[];
  const audio={paused:true,currentTime:0,src:'',addEventListener(name,fn){events[name]=fn},hasAttribute(){return Boolean(this.src)},getAttribute(){return this.src},play(){this.paused=false;calls.push([this.src,this.currentTime]);events.play();return Promise.resolve()},pause(){this.paused=true;events.pause?.()}};
  const track={querySelector:()=>null};
  const elements={initialAudioData:{textContent:'null'},screenOffAudio:audio,screenOffTrack:track};
  const $=id=>elements[id]??{};
  let current=1,isPaused=false;
  let generation=0;
  let selected='test',activeTab='listen';
  function lesson(){return {id:'test',sentences:rows}}
  function stop(message,keepMedia){generation++;if(!keepMedia)stopScreenOffAudio()}
  function say(message){messages.push(message)}
  function updatePlaybackButtons(){}
  function showNowReading(...args){readings.push(args)}
  function configureAudioSession(){sessionType='playback'}
  const readings=[];let sessionType='';
  function highlight(){}
  function resumeSpeech(){isPaused=false}
 `+source+`
  screenOffManifest={lessons:{test:{chinese,bilingual,chineseSignature:audioSignature(rows),bilingualSignature:audioSignature(rows)}},timings:{[chinese]:[0,2.5],[bilingual]:[0,4.8]}};
 `,context);
 return code=>vm.runInContext(code,context);
}
check('iPhone normal play starts the matching public track at the selected sentence, without opening the extra panel',()=>{
 const run=publishedAudioHarness();
 assert.equal(run(`playPublishedTrack('listen',()=>{throw Error('unexpected speech fallback')});calls[0].join(',')`),'audio/111111111111111111111111.mp3,2.5');
 assert.equal(run('audio.playbackRate'),.8);
 assert.equal(run(`stepSentence(-1);audio.currentTime`),0);
 assert.equal(run(`audio.currentTime=1.2;togglePlaybackPause();togglePlaybackPause();calls[1][1]`),1.2);
 assert.equal(run(`stopScreenOffAudio();settings.readJapanese=true;current=1;playPublishedTrack('listen',()=>{});calls.at(-1).join(',')`),'audio/222222222222222222222222.mp3,4.8');
});
check('Editable or desktop material keeps device speech instead of playing a mismatched recording',()=>{
 const edited=publishedAudioHarness(),desktop=publishedAudioHarness('Windows Chrome');
 assert.equal(edited(`rows[0].zh='編集済み';let fellBack=false;playPublishedTrack('listen',()=>{fellBack=true});fellBack&&!calls.length`),true);
 assert.equal(desktop(`let fellBack=false;playPublishedTrack('listen',()=>{fellBack=true});fellBack&&!calls.length`),true);
});
check('Screen-off audio repeats each Chinese and Japanese pair and adds the configured gap in one file',()=>{
 const run=publishedAudioHarness();
 const plan=JSON.parse(run(`
  const clip=[[1,3,15],[3,6,18]],pack={silence:[0,1]};
  const composed=composePublishedAudio(new Blob(['abcdef']),pack,[clip,clip],rows,{bilingual:true,repeat:3,gap:2000,rate:1});
  JSON.stringify({cues:composed.cues,offsets:composed.offsets,type:composed.blob.type,frame:mp3FrameSeconds})
 `));
 assert.deepEqual(plan.cues.map(v=>v.text),['你好','こんにちは','你好','こんにちは','你好','こんにちは','再见','さようなら','再见','さようなら','再见','さようなら']);
 assert.equal(plan.offsets[1],plan.cues[6].time);
 assert.ok(Math.abs(plan.cues[2].time-plan.cues[1].time-18*plan.frame+8*plan.frame-2)<plan.frame);
 assert.equal(plan.type,'audio/mpeg');
});
check('A filtered word-book selection uses packed audio and the current text follows the Japanese cue',()=>{
 const run=publishedAudioHarness();
 const r=JSON.parse(run(`
  const testPack={file:chinese,silence:[0,1],tracks:{words:{[audioSignature([rows[1]])]:[[1,3,10],[3,6,11]]}}};
  screenOffManifest.packs={vocabulary:{words:testPack}};activeTab='words';
  audioPacks.set(chinese,{blob:new Blob(['abcdef'])});
  playFromPack('bank','words',[rows[1]]);
  audio.currentTime=.45;updateMediaPosition();
  JSON.stringify({source:audio.src,reading:readings.at(-1),session:sessionType})
 `));
 assert.match(r.source,/^blob:/);
 assert.equal(r.session,'playback');
 assert.deepEqual(r.reading,['さようなら','ja-JP','1/1']);
});
console.log(`${checks} checks passed`);
