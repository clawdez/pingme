const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const src=fs.readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');
const helpers=src.slice(src.indexOf('async function signInSendCode'),src.indexOf('// The send-email `send`/`verify`'));
function app(fetch, fast=false) {
  const context=vm.createContext({fetch,AbortController,SUPABASE_URL:'https://mock.invalid',SUPABASE_ANON:'mock',setTimeout:fast?(fn)=>setTimeout(fn,5):setTimeout,clearTimeout});
  vm.runInContext(helpers,context);return context;
}
for(const fn of ['signInSendCode','signupSendCode']) {
  for(const [name,status,body,expected] of [
    ['accepted',200,{sent:true},null],
    ['empty success',200,{},'send_failed'],
    ['false sent',200,{sent:false},'send_failed'],
    ['null body',200,null,'send_failed'],
    ['HTTP failure with sent true',400,{sent:true},'send_failed'],
    ['outage',503,{error:'provider issue'},'email_unavailable'],
    ['structured unavailable',200,{code:'email_unavailable'},'email_unavailable'],
    ['cooldown',429,{},'rate_limited'],
    ['existing identity',200,{code:'already_registered'},'already_registered'],
    ['legacy generic sign-in recovery',200,{ok:false,error:'if that email exists, we sent a code'},'signin_unconfirmed'],
    ['contradictory response',200,{sent:true,error:'bad'},'send_failed']
  ]) test(fn+': '+name,async()=>{
    const context=app(async()=>({status,ok:status<400,json:async()=>body}));
    const result=await context[fn]('test@example.com');
    assert.equal(result.ok,expected===null);if(expected)assert.equal(result.code,expected);
  });
  test(fn+': network failure is recoverable',async()=>{
    const result=await app(async()=>{throw new Error('network');})[fn]('test@example.com');
    assert.equal(result.code,'network_error');
  });
  test(fn+': non-JSON body fails safely',async()=>{
    const result=await app(async()=>({status:200,ok:true,json:async()=>{throw new Error('bad JSON');}}))[fn]('test@example.com');
    assert.equal(result.code,'send_failed');
  });
  test(fn+': hung request times out and aborts',async()=>{
    let signal;
    const result=await app(async(_,opts)=>{signal=opts.signal;return new Promise(()=>{});},true)[fn]('test@example.com');
    assert.equal(result.code,'timeout');assert.equal(signal.aborted,true);
  });
  test(fn+': hung response body is bounded',async()=>{
    const result=await app(async()=>({status:200,ok:true,json:()=>new Promise(()=>{})}),true)[fn]('test@example.com');
    assert.equal(result.code,'timeout');
  });
}
test('sign-in outage keeps email, restores button and does not offer account creation',async()=>{
  const elements={};
  const element=id=>elements[id]||= {value:'',hidden:true,disabled:false,textContent:'',handlers:{},focus(){},addEventListener(event,fn){this.handlers[event]=fn;}};
  const root=element('setup-root');
  const context=app(async()=>({status:503,ok:false,json:async()=>({code:'email_unavailable'})}));
  Object.assign(context,{document:{getElementById:element},esc:s=>s,FEATURES:{},showSetup(){},showSetupSignupEmail(){},setTimeout(){return 1;}});
  vm.runInContext(src.slice(src.indexOf('function showSetupEmail('),src.indexOf('// Screen 1c')),context);
  context.showSetupEmail('');
  element('setup-email').value='kept@example.com';
  const html=root.innerHTML;
  await element('s-email-go').handlers.click();
  assert.equal(root.innerHTML,html);
  assert.equal(element('setup-email').value,'kept@example.com');
  assert.equal(element('s-email-go').disabled,false);
  assert.equal(element('s-email-nudge').hidden,true);
  assert.match(element('s-email-err').textContent,/temporarily unavailable/);
});
