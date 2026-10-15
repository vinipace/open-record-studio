// Narrow decoder benchmark. Reads media directly, never opens or edits a project
// in the editor and never records screen/camera input or runs the UI E2E suite.
import { app, BrowserWindow } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import assert from "node:assert/strict";

const directory = path.resolve(process.argv[2]);
const output = path.resolve(
  process.argv[3] || "evidence/playback/cut-handoff.json",
);
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "frame-cut-check-"));
app.setPath("userData", profile);
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.whenReady().then(async () => {
  let window;
  const bytes = await fs.readFile(path.join(directory, "project.json"));
  try {
    const project = JSON.parse(bytes);
    if (process.argv.includes("--dense")) {
      project.edits.segments = [
        { start: 0, end: 1 },
        { start: 2, end: 2.35 },
        { start: 4.867, end: project.duration },
      ];
      project.edits.style.speed = 1.5;
    }
    for (const track of Object.values(project.tracks))
      track.url = pathToFileURL(path.join(directory, track.file)).href;
    const compile = async (file) =>
      stripTypeScriptTypes(
        (await fs.readFile(file, "utf8"))
          .replace(/^import[\s\S]*?from "[^"]+";/gm, "")
          .replace(/export /g, ""),
        { mode: "transform" },
      );
    const code =
      (await compile("src/media-audio.ts")) +
      (await compile("src/cut-media.ts")) +
      (await compile("src/timeline.ts"));
    const html = path.join(profile, "decoder.html");
    await fs.writeFile(
      html,
      '<!doctype html><canvas width="960" height="624"></canvas>',
    );
    window = new BrowserWindow({
      show: false,
      webPreferences: { backgroundThrottling: false, sandbox: true },
    });
    await window.loadFile(html);
    const run = async (mode) =>
      window.webContents.executeJavaScript(`(async () => {
      ${code}
      const project = ${JSON.stringify(project)}, mode = ${JSON.stringify(mode)};
      const edits = project.edits, speed = edits.style.speed;
      const canvas = document.querySelector('canvas'), ctx = canvas.getContext('2d');
      const banks = {}, all = [], events = [], frames = [], cuts = [], samples = [];
      const media = {}, activeSeeks = [];
      let start = 0, time = 0, base = 0, sourceBase = 0, index = 0, lastFrame = -1;
      let frameCount = 0, missing = 0, lastWall = 0;
      const setup = (el,key) => {
        el.preload = 'auto'; all.push(el);
        for (const name of ['seeking','seeked','waiting','playing']) el.addEventListener(name, () => {
          if (media[key] === el && start) {
            events.push({key,name,at:performance.now()-start,time:el.currentTime});
            if(name==='seeking') activeSeeks.push({key,at:performance.now()-start});
          }
        });
        if(el instanceof HTMLVideoElement) {
          const presented = (now,meta) => {
            if (media[key] === el && start) frames.push({key,at:now-start,source:meta.mediaTime});
            el.requestVideoFrameCallback(presented);
          };
          el.requestVideoFrameCallback(presented);
        }
      };
      for (const key of ['screen','camera','microphone']) {
        const track = project.tracks[key]; if(!track)continue;
        const el = document.createElement(key==='microphone'?'audio':'video'); media[key]=el;
        banks[key] = new CutMedia(el, other => setup(other,key));
        banks[key].setVolume(0); el.src = track.url;
        await new Promise((resolve,reject) => {el.addEventListener('loadeddata',resolve,{once:true});el.addEventListener('error',()=>reject(new Error('Cannot load '+key)),{once:true});});
        const target = Math.max(0,edits.segments[0].start-track.offset-(key==='camera'?edits.style.cameraOffset:0));
        if(target>0.004) {el.currentTime=target;await new Promise(resolve=>el.addEventListener('seeked',resolve,{once:true}));}
        el.playbackRate=speed;
      }
      const master = project.tracks.microphone && !project.tracks.screen.audio ? 'microphone' : 'screen';
      sourceBase = media[master].currentTime;
      start=performance.now(); lastWall=start;
      await Promise.all(Object.values(media).map(el=>el.play()));
      await new Promise((resolve,reject) => {
        const tick=()=>{
          try {
            const now=performance.now(), elapsed=(now-start)/1000;
            if(elapsed>8 || time>=Math.min(duration(edits)-0.05,6.5)){resolve();return;}
            time=base+Math.max(0,media[master].currentTime-sourceBase)/speed;
            const current=segmentAt(edits,time), source=sourceTime(edits,time), cut=current!==index;
            if(cut){base=time;sourceBase=source-project.tracks[master].offset; cuts.push({at:now-start,time});}
            const next=nextMediaCut(edits,time);
            for(const key of Object.keys(media)) {
              const track=project.tracks[key], bank=banks[key];
              const target=source-track.offset-(key==='camera'?edits.style.cameraOffset:0);
              if(cut) {
                const ready=mode==='prepared' && bank.handoff(String(current),target,speed);
                media[key]=bank.element;
                if(ready && key===master){base=time;sourceBase=media[key].currentTime;}
                if(!ready) bank.seek(target);
                cuts.at(-1)[key]={ready,drift:media[key].currentTime-target};
                if(media[key].paused)void media[key].play();
              } else if(key!==master) {
                if(mode==='prepared') bank.follow(target,speed);
                else if(!media[key].seeking && Math.abs(media[key].currentTime-target)>0.08)bank.seek(target);
              }
              if(mode==='prepared' && next)bank.prepare(String(next.index),next.source-track.offset-(key==='camera'?edits.style.cameraOffset:0),next.time-time,speed);
            }
            index=current;
            const image = mode==='prepared' ? banks.screen.image() : media.screen;
            if(image && (mode==='prepared' || (!image.seeking && image.readyState>=2))) {
              ctx.drawImage(image,0,0,960,624);frameCount++;
              if(media.camera) {
                const camera = mode==='prepared'?banks.camera.image():media.camera;
                if(!camera || camera.readyState<2)missing++;
                else ctx.drawImage(camera,0,0,200,150);
              }
            } else missing++;
            samples.push({at:now-start,time,screen:media.screen.currentTime,mic:media[master].currentTime});
            requestAnimationFrame(tick);
          } catch(error){reject(error);}
        }; requestAnimationFrame(tick);
      });
      for(const el of all){el.pause();el.removeAttribute('src');el.load();}
      const summary = {mode,elapsed:(performance.now()-start)/1000,time,frameCount,missing,cuts,activeSeeks};
      for(const key of ['screen','camera']) {
        const points=frames.filter(f=>f.key===key), gaps=points.slice(1).map((p,i)=>p.at-points[i].at);
        const boundaryGaps=points.slice(1).flatMap((p,i)=>cuts.some(c=>points[i].at<c.at+600 && p.at>c.at-150)?[p.at-points[i].at]:[]);
        summary[key]={frames:points.length,maxFrameGapMs:Math.max(0,...gaps),maxCutGapMs:Math.max(0,...boundaryGaps)};
      }
      const deltas=samples.slice(1).filter((s,i)=>s.time<=samples[i].time+0.00001);
      summary.stalledSamples=deltas.length;
      return {summary,events,frames,samples};
    })()`);
    const baseline = process.argv.includes("--only-prepared")
      ? null
      : await run("baseline");
    const prepared = await run("prepared");
    if (
      !(await fs.readFile(path.join(directory, "project.json"))).equals(bytes)
    )
      throw new Error("Source project changed");
    const report = {
      date: new Date().toISOString(),
      projectSha256: createHash("sha256").update(bytes).digest("hex"),
      segments: project.edits.segments,
      speed: project.edits.style.speed,
      baseline,
      prepared,
    };
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(report, null, 2));
    console.log(
      JSON.stringify({
        baseline: baseline?.summary,
        prepared: prepared.summary,
      }),
    );
    assert.equal(prepared.summary.missing, 0, "No unavailable preview images");
    assert.equal(
      prepared.summary.activeSeeks.length,
      0,
      "Prepared cuts never seek the active decoder",
    );
    for (const cut of prepared.summary.cuts)
      for (const key of Object.keys(project.tracks))
        assert.equal(cut[key].ready, true, `${key} must be ready at the cut`);
    assert(
      prepared.summary.screen.maxCutGapMs < 100,
      "No long screen-frame stall at a cut",
    );
    if (project.tracks.camera)
      assert(
        prepared.summary.camera.maxCutGapMs < 150,
        "No long webcam-frame stall at a cut",
      );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    window?.destroy();
    await fs.rm(profile, { recursive: true, force: true });
    app.quit();
  }
});
