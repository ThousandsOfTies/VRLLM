import './style.css';
import { VRMViewer }      from './vrm-viewer.js';
import { LLMClient }      from './llm-client.js';
import { SpeechManager }  from './speech.js';
import { LipSync }        from './lip-sync.js';
import { GoogleDriveSync } from './google-drive-sync.js';
import { LocalStorage }   from './local-storage.js';
import { AppStorage }     from './app-storage.js';
import { initApp }        from './appInit.js';

const canvas   = document.getElementById('vrm-canvas');
const viewer   = new VRMViewer(canvas);
const llm      = new LLMClient();
const speech   = new SpeechManager(llm);
const lipSync  = new LipSync(viewer);
const driveSync = new GoogleDriveSync();
const local    = new LocalStorage();
const storage  = new AppStorage(driveSync, local);

initApp({ viewer, llm, speech, lipSync, driveSync, storage, local, canvas })
  .catch(err => console.warn('App init error:', err));
