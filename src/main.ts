// Boot: create the Studio engine, mount the UI around it and start loading the SHARP model.

import { Studio } from './engine/studio';
import { studioUI } from './ui/studio';

const studio = new Studio();
studioUI.mount(document.getElementById('root')!, { studio });
studio.autoLoadModel();

// Console handle for debugging and automation.
(window as unknown as { sharprig: unknown }).sharprig = { studio };
