import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { compileStyle, parse } from '@vue/compiler-sfc'

const require = createRequire(import.meta.url)

test('caption diffuses ordinary page backdrops and stays transparent on immersive pages', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-caption-material-'))
  try {
    const read = (path: string): Promise<string> => readFile(new URL(path, import.meta.url), 'utf8')
    const source = parse(await read('./TitleBar.vue')).descriptor.styles[0].content
    const compiled = compileStyle({
      source,
      filename: 'TitleBar.vue',
      id: 'data-v-caption',
      scoped: true
    })
    assert.deepEqual(compiled.errors, [])
    const styles = [
      await read('../assets/base.css'),
      await read('../assets/appearance.css'),
      ...parse(await read('../App.vue')).descriptor.styles.map((style) => style.content),
      compiled.code
    ].join('\n')
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-platform="win32"><head>
      <meta charset="utf-8"><style>${styles}
      html,body{margin:0;width:100%;height:100%;overflow:hidden}
      body{background:#16181b}
      .sample-backdrop{position:fixed;inset:0;background:repeating-linear-gradient(90deg,#e64343 0 6px,#2059b8 6px 12px);pointer-events:none}
      .app-shell-title{z-index:2100}
      .title-bar{--te-app-bg:#17181a;--te-player-bg:#08121d;--te-shell-control-text:#f4f7fb;
        --te-lg-context-material:rgb(18 28 45 / 38%);--te-lg-context-surface-solid:#121c2d;
        --te-lg-context-label:#f8fafc;--te-lg-context-diffusion:20px}
      .title-bar-start button{width:46px;height:40px;color:inherit;border:0;background:transparent}
      *,*::before,*::after{transition:none!important}
      </style></head><body><div class="sample-backdrop"></div><div class="app-shell"><div class="app-shell-title">
      <div class="title-bar" data-v-caption><div class="title-bar-background" data-v-caption></div>
      <div class="title-bar-start" data-v-caption><button class="menu-btn" data-v-caption aria-label="导航">☰</button></div>
      <div class="title-bar-controls" data-v-caption><div class="title-bar-tools" data-v-caption>
      <button class="settings-btn" data-v-caption aria-pressed="true" aria-label="设置">⚙</button>
      <button class="plugins-btn" data-v-caption aria-pressed="true" aria-label="扩展">◇</button>
      <button class="control-btn notification-btn" data-v-caption aria-expanded="true" aria-label="通知">♧</button>
      </div><div class="title-bar-window-controls" data-v-caption><button class="control-btn close" data-v-caption aria-label="关闭">×</button></div></div>
      </div></div></div><script>
      const title=document.querySelector('.title-bar'),painter=document.querySelector('.title-bar-background');
      window.prepare=(tone,page,liquid)=>{
        document.documentElement.dataset.theme=tone;
        document.documentElement.dataset.teLiquidGlassSource='solid';
        title.className='title-bar'+(page==='playing'?' title-bar-immersive':page==='settings'?' title-bar-settings':page==='streaming'?' title-bar-streaming':'')+(liquid&&page!=='playing'?' title-bar-liquid':'');
        document.querySelector('.sample-backdrop').style.background='repeating-linear-gradient(90deg,#e64343 0 6px,#2059b8 6px 12px)';
        const style=getComputedStyle(painter),host=getComputedStyle(title),rect=title.getBoundingClientRect();
        if(page==='playing' ? style.backdropFilter!=='none' : !style.backdropFilter.includes('blur('))throw Error('wrong caption material: '+tone+'/'+page+'/'+liquid);
        if(style.backgroundImage!=='none'||style.boxShadow!=='none'||host.boxShadow!=='none')throw Error('caption creates a second decorative band');
        if(host.backgroundImage!=='none'||host.backgroundColor!=='rgba(0, 0, 0, 0)')throw Error('caption host masks its backdrop');
        const c=document.createElement('canvas');c.width=c.height=1;const x=c.getContext('2d');x.fillStyle=style.backgroundColor;x.fillRect(0,0,1,1);const alpha=x.getImageData(0,0,1,1).data[3]/255;if(page==='playing' ? alpha!==0 : alpha>.31||alpha<.2)throw Error('caption tint creates an independent material band: '+alpha);
        if(rect.height!==40||rect.left!==0||rect.right!==innerWidth)throw Error('caption geometry changed');
        if(document.elementFromPoint(22,20)?.closest('button')===null)throw Error('material intercepts navigation input');
        for(const button of title.querySelectorAll('.title-bar-tools button')){
          const state=getComputedStyle(button),feedback=getComputedStyle(button,'::before'),box=button.getBoundingClientRect();
          if(box.width!==46||box.height!==40)throw Error('tool hit area changed');
          if(feedback.top!=='5px'||feedback.left!=='7px'||feedback.borderRadius!=='9px')throw Error('tool feedback is not inset and rounded');
          if(feedback.backgroundColor==='rgba(0, 0, 0, 0)')throw Error('selection depends on icon colour alone');
          if(state.backgroundColor!=='rgba(0, 0, 0, 0)')throw Error('tool paints a full caption rectangle');
          if(document.elementFromPoint(box.left+2,box.top+2)!==button)throw Error('inset feedback shrinks the click target');
        }
        if(getComputedStyle(title.querySelector('.close')).borderRadius!=='0px')throw Error('tool styling changes native window buttons');
      };
      window.checkFallback=(kind)=>{
        const root=document.documentElement;
        if(kind==='effects')root.dataset.teEffectsMode='reduced';
        if(kind==='blur')document.body.classList.add('te-no-blur');
        if(kind==='transparent')root.dataset.teSurfaceMaterial='transparent';
        const style=getComputedStyle(painter);
        if(style.backdropFilter!=='none')throw Error('fallback still blurs: '+kind);
        if(kind==='transparent'&&style.backgroundColor!=='rgba(0, 0, 0, 0)')throw Error('transparent preference leaves a painted strip');
        if(kind!=='transparent'&&style.backgroundColor.includes(' / '))throw Error('accessibility fallback remains translucent');
        if(matchMedia('(forced-colors: active)').matches){
          const selected=title.querySelector('.settings-btn');
          if(getComputedStyle(selected).forcedColorAdjust!=='none'||getComputedStyle(selected,'::before').backgroundColor==='rgba(0, 0, 0, 0)')throw Error('system colours lose the selected tool');
        }else if(matchMedia('(prefers-contrast: more)').matches){
          const selected=title.querySelector('.settings-btn'),probe=document.createElement('span');
          probe.style.color='var(--te-shell-control-text)';title.append(probe);
          if(getComputedStyle(selected).color!==getComputedStyle(probe).color)throw Error('high contrast tool retains low contrast tint');
          probe.remove();
        }
        delete root.dataset.teEffectsMode;delete root.dataset.teSurfaceMaterial;document.body.classList.remove('te-no-blur');
      };
      </script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow,nativeImage}=require('electron');
      app.setPath('userData',require('node:path').join(__dirname,'profile'));
      app.whenReady().then(async()=>{
        const win=new BrowserWindow({show:false,width:800,height:400,useContentSize:true,webPreferences:{offscreen:{deviceScaleFactor:1},contextIsolation:false,backgroundThrottling:false}});
        try{
          await win.loadFile(process.argv.at(-1));win.webContents.debugger.attach('1.3');
          const js=async source=>{
            const result=await win.webContents.executeJavaScript('(()=>{try{'+source+';return null}catch(error){return String(error)}})()');
            if(result)throw Error(result+' ['+source+']');
          };
          const capture=async()=>nativeImage.createFromBuffer(Buffer.from((await win.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true})).data,'base64')).toBitmap();
          const settle=()=>new Promise(resolve=>setTimeout(resolve,90));
          const difference=(a,b)=>{let sum=0;for(let x=180;x<620;x++)for(let c=0;c<3;c++)sum+=Math.abs(a[(20*800+x)*4+c]-b[(20*800+x)*4+c]);return sum/(440*3)};
          for(const tone of ['dark','pureWhite'])for(const page of ['home','streaming','settings','playing'])for(const liquid of [false,true]){
            await js('prepare('+JSON.stringify(tone)+','+JSON.stringify(page)+','+liquid+')');await settle();
            const blurred=await capture();
            await js('document.querySelector(".title-bar-background").style.backdropFilter="none"');await settle();
            const sharp=await capture();
            if(page==='playing' ? difference(blurred,sharp)>.5 : difference(blurred,sharp)<4)throw Error('caption does not preserve its page material: '+tone+'/'+page+'/'+liquid);
            await js('document.querySelector(".title-bar-background").style.backdropFilter="";document.querySelector(".sample-backdrop").style.background="#44ab62"');await settle();
            if(difference(blurred,await capture())<10)throw Error('caption hides backdrop colour');
            for(const kind of ['effects','blur','transparent'])await js('checkFallback('+JSON.stringify(kind)+')');
            for(const [name,value] of [['prefers-reduced-transparency','reduce'],['prefers-contrast','more'],['forced-colors','active']]){
              await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name,value}]});
              try{await js('checkFallback("media")')}catch(error){throw Error(tone+'/'+page+'/'+liquid+'/'+name+': '+error)}
              await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});
            }
          }
          await js('prepare("dark","home",true)');
          const point=await win.webContents.executeJavaScript('(()=>{const r=document.querySelector(".settings-btn").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:20}})()');
          win.webContents.sendInputEvent({type:'mouseMove',...point});await settle();
          await js('const b=document.querySelector(".settings-btn");if(!b.matches(":hover"))throw Error("tool does not receive real hover");if(getComputedStyle(b).backgroundColor!=="rgba(0, 0, 0, 0)")throw Error("hover becomes a full strip")');
          win.webContents.sendInputEvent({type:'mouseMove',x:350,y:200});
          await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
          await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
          await js('const b=document.activeElement;if(b.tagName!=="BUTTON"||!b.matches(":focus-visible")||getComputedStyle(b,"::before").outlineWidth!=="2px")throw Error("keyboard focus feedback missing")');
          console.error('CAPTION_MATERIAL_OK 16 page/tone/material combinations');app.exit(0);
        }catch(error){console.error(error);app.exit(1)}
      });`
    )
    const environment = { ...process.env }
    delete environment.ELECTRON_RUN_AS_NODE
    const { stderr } = await promisify(execFile)(
      require('electron') as string,
      [join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 90_000, env: environment }
    )
    assert.match(stderr, /CAPTION_MATERIAL_OK 16/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
