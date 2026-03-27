import type {
  ServerStateMessage,
  ServerMessage,
  ServerDiceMessage,
  ServerScriptMessage,
  ServerSceneMessage,
  ServerErrorMessage,
  ServerIdMessage,
  SceneOption,
  GameState,
  ScenePayload,
  ClientJoinMessage,
} from '../shared/types';

type View = 'intro' | 'dice' | 'feed';

interface Character {
  name: string;
  role: string;
}

const STORAGE_PLAYER_ID = 'dice-ritual-player-id';
const STORAGE_DISPLAY_NAME = 'dice-ritual-display-name';

const root = document.getElementById('app');

if (!root) {
  throw new Error('Missing #app root');
}

root.innerHTML = `
  <section class="panel" id="introPanel">
    <h1>Morning in the Tavern</h1>
    <p class="hint">Create a quick character and join the rolling table.</p>
    <form id="joinForm">
      <label>
        Character Name
        <input id="nameInput" type="text" placeholder="Player name" required />
      </label>
      <label>
        Role
        <select id="roleSelect">
          <option value="Ranger">Ranger</option>
          <option value="Mage">Mage</option>
          <option value="Cleric">Cleric</option>
          <option value="Rogue">Rogue</option>
        </select>
      </label>
      <button type="submit">Enter the Hall</button>
    </form>
  </section>

  <section class="panel hidden" id="dicePanel">
    <h2>Questyboy's Quest</h2>
    <p id="characterSummary" class="hint"></p>
    <article class="scene" id="scenePanel">
      <h3>Scene</h3>
      <p id="sceneText" class="scene-text hint">Waiting for the GM to begin the tale.</p>
      <div id="sceneOptions" class="scene-options"></div>
      <p id="sceneDiceHint" class="hint"></p>
    </article>
  <div class="players">
    <h3>Current Players</h3>
    <ul id="playersList"></ul>
  </div>
  <div class="panels-row">
    <article class="info-panel" id="statsPanel">
      <h4>Stats</h4>
      <ul id="statsList"></ul>
    </article>
    <article class="info-panel" id="inventoryPanel">
      <h4>Inventory</h4>
      <ul id="inventoryList"></ul>
    </article>
  </div>
    <p class="hint" id="turnLine"></p>
    <div class="master-controls">
      <button id="beginMasterBtn">Begin as master</button>
      <div id="masterPanel" class="hidden">
        <p class="hint" id="masterStatus"></p>
        <button id="startGameBtn">Start Game</button>
      </div>
    </div>
    <div class="script-status" id="scriptStatusLine">Awaiting script upload.</div>
    <div class="script-upload hidden" id="scriptUploadSection">
      <label>
        Script file (.rpgjson)
        <input id="scriptFileInput" type="file" accept=".rpgjson" />
      </label>
      <button type="button" id="uploadScriptBtn">Upload script</button>
    </div>
    <div class="panel-footer">
      <button id="rollBtn">Roll d20</button>
      <button id="viewFeedBtn">View Dice Feed</button>
    </div>
    <p class="status" id="statusLine"></p>
  </section>

  <section class="panel hidden" id="feedPanel">
    <h2>Dice Feed</h2>
    <ul id="feedList"></ul>
    <div class="panel-footer">
      <button id="backToDiceBtn">Back to Dice</button>
    </div>
  </section>
`;

const joinForm = document.getElementById('joinForm') as HTMLFormElement;
const nameInput = document.getElementById('nameInput') as HTMLInputElement;
const roleSelect = document.getElementById('roleSelect') as HTMLSelectElement;
const dicePanel = document.getElementById('dicePanel') as HTMLElement;
const feedPanel = document.getElementById('feedPanel') as HTMLElement;
const introPanel = document.getElementById('introPanel') as HTMLElement;
const playersList = document.getElementById('playersList') as HTMLUListElement;
const feedList = document.getElementById('feedList') as HTMLUListElement;
const characterSummary = document.getElementById('characterSummary') as HTMLElement;
const rollBtn = document.getElementById('rollBtn') as HTMLButtonElement;
const viewFeedBtn = document.getElementById('viewFeedBtn') as HTMLButtonElement;
const backToDiceBtn = document.getElementById('backToDiceBtn') as HTMLButtonElement;
const statusLine = document.getElementById('statusLine') as HTMLElement;
const turnLine = document.getElementById('turnLine') as HTMLElement;
const beginMasterBtn = document.getElementById('beginMasterBtn') as HTMLButtonElement;
const masterControls = document.querySelector('.master-controls') as HTMLElement;
const masterPanel = document.getElementById('masterPanel') as HTMLElement;
const masterStatus = document.getElementById('masterStatus') as HTMLElement;
const startGameBtn = document.getElementById('startGameBtn') as HTMLButtonElement;
const scriptUploadSection = document.getElementById('scriptUploadSection') as HTMLElement;
const scriptFileInput = document.getElementById('scriptFileInput') as HTMLInputElement;
const uploadScriptBtn = document.getElementById('uploadScriptBtn') as HTMLButtonElement;
const scriptStatusLine = document.getElementById('scriptStatusLine') as HTMLElement;
const sceneText = document.getElementById('sceneText') as HTMLElement;
const sceneOptions = document.getElementById('sceneOptions') as HTMLElement;
const sceneDiceHint = document.getElementById('sceneDiceHint') as HTMLElement;
const statsList = document.getElementById('statsList') as HTMLUListElement;
const inventoryList = document.getElementById('inventoryList') as HTMLUListElement;

const players = new Map<string, { name: string; order: number }>();
let lastLogIndex = 0;
let ws: WebSocket | null = null;
let connected = false;
let character: Character | null = null;
let localId: string | null = null;
let currentTurnId: string | null = null;
let nextTurnId: string | null = null;
let latestState: GameState | null = null;
let latestScene: ScenePayload | null = null;
let awaitingSceneUpdate = false;

const showView = (view: View) => {
  introPanel.classList.toggle('hidden', view !== 'intro');
  dicePanel.classList.toggle('hidden', view !== 'dice');
  feedPanel.classList.toggle('hidden', view !== 'feed');
};

const updatePlayersList = () => {
  playersList.innerHTML = '';
  const sorted = Array.from(players.entries()).sort((a, b) => a[1].order - b[1].order);
  for (const [id, info] of sorted) {
    const line = document.createElement('li');
    line.textContent = `${info.order}. ${info.name} (${id.slice(0, 4)})`;
    playersList.append(line);
  }
};

const updateStatsView = (state: GameState) => {
  statsList.innerHTML = '';
  if (!localId) {
    statsList.innerHTML = '<li>Connect to see your stats.</li>';
    return;
  }
  const player = state.players[localId];
  if (!player) {
    statsList.innerHTML = '<li>Awaiting master acceptance.</li>';
    return;
  }
  const stats = [
    `HP: ${player.hp}`,
    `Position: ${player.position.x}, ${player.position.y}`,
    `Order: ${player.order}`,
  ];
  stats.forEach((value) => {
    const row = document.createElement('li');
    row.textContent = value;
    statsList.append(row);
  });
};

const updateInventoryView = (state: GameState) => {
  inventoryList.innerHTML = '';
  if (!localId) {
    inventoryList.innerHTML = '<li>No inventory until you join.</li>';
    return;
  }
  const items = state.playerInventory[localId] ?? [];
  if (!items.length) {
    inventoryList.innerHTML = '<li>Empty</li>';
    return;
  }
  items.forEach((item: string) => {
    const row = document.createElement('li');
    row.textContent = item;
    inventoryList.append(row);
  });
};

const addFeedEntry = (text: string) => {
  const item = document.createElement('li');
  item.textContent = text;
  feedList.prepend(item);
};

const getPlayerName = (id: string | null) => {
  if (!id) return '—';
  const info = players.get(id);
  if (!info) return id;
  return info.name;
};

const updateTurnStatus = (state: GameState) => {
  if (!state.gameStarted) {
    turnLine.textContent = '';
    return;
  }
  const current = getPlayerName(state.currentTurnId);
  const next = getPlayerName(state.nextTurnId);
  turnLine.textContent = `Current: ${current} ? Next: ${next}`;
};


const getPlayerLabel = (id: string | null) => {
  if (!id) return '—';
  const info = players.get(id);
  if (!info) return id;
  return `${info.order}. ${info.name}`;
};

const refreshFeedFromLog = (state: GameState) => {
  if (state.log.length < lastLogIndex) {
    feedList.innerHTML = '';
    lastLogIndex = 0;
  }
  while (lastLogIndex < state.log.length) {
    addFeedEntry(state.log[lastLogIndex]);
    lastLogIndex += 1;
  }
};

const updateSceneDisplay = (payload: ScenePayload) => {
  if (payload.playerId !== localId) return;
  latestScene = payload;
  sceneText.textContent = payload.text || 'The script is waiting for the master to proceed.';
  sceneOptions.innerHTML = '';
  const isCurrentPlayer = Boolean(
    latestState && latestState.gameStarted && latestState.currentTurnId === localId
  );
  if (!isCurrentPlayer) {
    const placeholder = document.createElement('p');
    placeholder.className = 'hint';
    const waitingFor = getPlayerName(latestState?.currentTurnId ?? null);
    placeholder.textContent = `Waiting for ${waitingFor} to finish their turn.`;
    sceneOptions.append(placeholder);
    sceneDiceHint.textContent = 'Hang tight until it is your turn.';
  } else if (payload.options.length) {
    payload.options.forEach((option, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'scene-option';
      button.textContent = option.text;
      button.dataset.index = index.toString();
      sceneOptions.append(button);
    });
    sceneDiceHint.textContent = payload.diceRollRequired
      ? 'Dice rolls determine the outcome of this scene.'
      : 'Choose a path to continue.';
  } else {
    const placeholder = document.createElement('p');
    placeholder.className = 'hint';
    placeholder.textContent = payload.diceRollRequired
      ? 'A dice roll will resolve this moment.'
      : 'No choices are available right now.';
    sceneOptions.append(placeholder);
    sceneDiceHint.textContent = payload.diceRollRequired
      ? 'Dice rolls determine the outcome of this scene.'
      : 'Choose a path to continue.';
  }
  awaitingSceneUpdate = false;
  refreshChoiceAvailability();
};

const refreshChoiceAvailability = () => {
  const canRoll =
    Boolean(latestState && latestState.gameStarted && latestState.currentTurnId === localId);
  sceneOptions.querySelectorAll('button').forEach((button) => {
    const disable = awaitingSceneUpdate || !canRoll;
    (button as HTMLButtonElement).disabled = disable;
  });
  const diceRequired = latestScene?.diceRollRequired ?? false;
  rollBtn.hidden = !diceRequired || !latestScene;
  rollBtn.disabled = !canRoll || !diceRequired;
};

const updateScriptUI = (state: GameState) => {
  const isMaster = state.masterId === localId;
  if (!state.masterId) {
    scriptStatusLine.textContent = 'Waiting for a GM to claim the seat.';
  } else if (!state.scriptLoaded) {
    scriptStatusLine.textContent = isMaster
      ? 'Upload a .rpgjson script to begin the game.'
      : `${getPlayerLabel(state.masterId)} is preparing the script.`;
  } else {
    const scriptName = state.scriptName ? `: ${state.scriptName}` : '';
    scriptStatusLine.textContent = `Script loaded${scriptName}.`;
  }

  const showUploader = isMaster && !state.gameStarted;
  scriptUploadSection.classList.toggle('hidden', !showUploader);
  scriptFileInput.disabled = !showUploader;
  uploadScriptBtn.disabled = !showUploader;
  scriptStatusLine.classList.toggle('hidden', state.gameStarted);
};

const getLocalSceneState = (state: GameState) => {
  if (!localId) return null;
  return state.playerScenes[localId] ?? null;
};

const updateSceneFromState = (state: GameState) => {
  if (!state.scriptLoaded) {
    latestScene = null;
    sceneText.textContent = 'Waiting for the GM to upload a script.';
    sceneOptions.innerHTML = '';
    sceneDiceHint.textContent = 'A script is required before the adventure can begin.';
    rollBtn.hidden = true;
    return;
  }
  if (!state.gameStarted) {
    latestScene = null;
    sceneText.textContent = 'Game will start once the GM hits Start Game.';
    sceneOptions.innerHTML = '';
    sceneDiceHint.textContent = 'Stand by for the first scene.';
    rollBtn.hidden = true;
    return;
  }
  const sceneState = getLocalSceneState(state);
  if (!sceneState) {
    latestScene = null;
    sceneText.textContent = 'Waiting for your scene to load.';
    sceneOptions.innerHTML = '';
    sceneDiceHint.textContent = 'Hold tight while the GM spins the tale.';
    rollBtn.hidden = true;
    return;
  }
      updateSceneDisplay({
        playerId: localId ?? '',
        sceneId: sceneState.sceneId,
        text: sceneState.sceneText || 'Waiting for the story to unfold.',
        options: sceneState.availableOptions,
        diceRollRequired: sceneState.diceRollRequired,
        rollState: sceneState.rollState,
      });
};

const sendChooseOption = (index: number) => {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    statusLine.textContent = 'Connection lost. Reload to reconnect.';
    return;
  }
  awaitingSceneUpdate = true;
  sceneOptions.querySelectorAll('button').forEach((button) => {
    (button as HTMLButtonElement).disabled = true;
  });
  ws.send(JSON.stringify({ type: 'chooseOption', payload: { optionIndex: index } }));
};

sceneOptions.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  if (!(target instanceof HTMLButtonElement)) return;
  const index = target.dataset.index;
  if (!index) return;
  if (!latestState?.gameStarted || awaitingSceneUpdate) {
    return;
  }
  sendChooseOption(Number(index));
});

const updateLobbyStatus = (state: GameState) => {
  if (!state.masterId) {
    statusLine.textContent = 'Connected. Waiting for a GM to claim the seat.';
    return;
  }
  const masterName = getPlayerLabel(state.masterId);
  if (!state.gameStarted) {
    if (state.masterId === localId) {
      statusLine.textContent = 'You are the GM. Start the game when ready.';
    } else {
      statusLine.textContent = `${masterName} is GM. Waiting for them to start the game.`;
    }
    return;
  }
  statusLine.textContent = `Game in progress. ${masterName} is guiding the session.`;
};

const updateMasterControls = (state: GameState) => {
  const isMaster = state.masterId === localId;
  masterControls.classList.toggle('hidden', state.gameStarted);
  masterPanel.classList.toggle('hidden', !isMaster || state.gameStarted);
  beginMasterBtn.disabled = !connected || (state.masterId !== null && !isMaster) || state.gameStarted;
  if (isMaster && !state.gameStarted) {
    if (!state.scriptLoaded) {
      masterStatus.textContent = 'Upload a script before starting the game.';
      startGameBtn.disabled = true;
    } else {
      masterStatus.textContent = 'You control the table. Hit Start Game when ready.';
      startGameBtn.disabled = false;
    }
  } else if (!state.masterId) {
    masterStatus.textContent = 'Claim the Game Master seat to coordinate the table.';
    startGameBtn.disabled = true;
  } else {
    masterStatus.textContent = `${getPlayerLabel(state.masterId)} is GM.`;
    startGameBtn.disabled = true;
  }
  if (state.gameStarted) {
    startGameBtn.disabled = true;
    beginMasterBtn.disabled = true;
  }
};

const applyState = (state: GameState) => {
  latestState = state;
  players.clear();
  Object.entries(state.players)
    .sort((a, b) => a[1].order - b[1].order)
    .forEach(([id, player]) => {
      players.set(id, { name: player.displayName, order: player.order });
    });
  updatePlayersList();
  updateStatsView(state);
  updateInventoryView(state);

  currentTurnId = state.currentTurnId;
  nextTurnId = state.nextTurnId;
  updateTurnStatus(state);
  updateLobbyStatus(state);
  updateMasterControls(state);
  updateScriptUI(state);
  refreshFeedFromLog(state);
  updateSceneFromState(state);
  refreshChoiceAvailability();
};

const connect = (name: string) => {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = `${protocol}://${location.host}`;

  ws = new WebSocket(wsUrl);

  ws.addEventListener('open', () => {
    connected = true;
    statusLine.textContent = 'Connected. Waiting for a GM to claim the seat.';
    const storedId = localStorage.getItem(STORAGE_PLAYER_ID);
    const joinPayload: ClientJoinMessage = {
      type: 'join',
      payload: {
        displayName: name,
      },
    };
    if (storedId) {
      joinPayload.payload.playerId = storedId;
    }
    ws?.send(JSON.stringify(joinPayload));
    showView('dice');
  });

  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data) as ServerMessage;

    switch (message.type) {
      case 'id': {
        const idMessage = message as ServerIdMessage;
        localId = idMessage.payload.playerId;
        localStorage.setItem(STORAGE_PLAYER_ID, localId);
        break;
      }
      case 'state': {
        const stateMessage = message as ServerStateMessage;
        applyState(stateMessage.payload);
        break;
      }
      case 'sceneUpdate': {
        const sceneMessage = message as ServerSceneMessage;
        updateSceneDisplay(sceneMessage.payload);
        break;
      }
      case 'diceResult': {
        const dice = message as ServerDiceMessage;
        const playerName = players.get(dice.payload.playerId)?.name ?? 'Unknown';
        addFeedEntry(`${playerName} rolled ${dice.payload.total}`);
        break;
      }
      case 'scriptUpdate': {
        const scriptMessage = message as ServerScriptMessage;
        const playerName = players.get(scriptMessage.payload.playerId)?.name ?? 'Unknown';
        addFeedEntry(`${playerName} ${scriptMessage.payload.message}`);
        break;
      }
      case 'error': {
        const errorMessage = message as ServerErrorMessage;
        statusLine.textContent = errorMessage.payload.message;
        break;
      }
    }
  });

  ws.addEventListener('close', () => {
    connected = false;
    statusLine.textContent = 'Disconnected. Refresh to reconnect.';
  });
};

joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = nameInput.value.trim();
  const role = roleSelect.value;
  if (!name) {
    nameInput.focus();
    return;
  }

  localStorage.setItem(STORAGE_DISPLAY_NAME, name);
  character = { name, role };
  characterSummary.textContent = `You are ${name}, the ${role}.`;
  statusLine.textContent = 'Connecting...';
  connect(name);
});

rollBtn.disabled = true;
rollBtn.hidden = true;
beginMasterBtn.disabled = true;
startGameBtn.disabled = true;

const uploadScriptFile = async () => {
  if (!ws || ws.readyState !== WebSocket.OPEN || !localId) {
    scriptStatusLine.textContent = 'Connect and claim the Game Master seat before uploading.';
    return;
  }
  const file = scriptFileInput.files?.[0];
  if (!file) {
    scriptStatusLine.textContent = 'Select a .rpgjson file first.';
    return;
  }
  if (!file.name.toLowerCase().endsWith('.rpgjson')) {
    scriptStatusLine.textContent = 'File must end with .rpgjson.';
    return;
  }
  scriptStatusLine.textContent = 'Validating script...';
  let parsed: unknown;
  try {
    const rawText = await file.text();
    const cleanText = rawText.replace(/^\uFEFF/, '');
    parsed = JSON.parse(cleanText);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown parsing error';
    scriptStatusLine.textContent = `Unable to parse the script file: ${message}`;
    return;
  }
  try {
    const response = await fetch('/upload-script', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: file.name,
        script: parsed,
        playerId: localId,
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error ?? 'Upload failed.');
    }
    scriptStatusLine.textContent = payload.status ?? 'Script uploaded.';
    scriptFileInput.value = '';
  } catch (error) {
    scriptStatusLine.textContent = error instanceof Error ? error.message : 'Upload failed.';
  }
};

uploadScriptBtn.addEventListener('click', () => {
  uploadScriptFile();
});

rollBtn.addEventListener('click', () => {
  if (!connected || !ws || ws.readyState !== WebSocket.OPEN) {
    statusLine.textContent = 'Not connected yet.';
    return;
  }
  if (!latestState?.gameStarted) {
    statusLine.textContent = 'Game has not started yet.';
    return;
  }
  if (localId !== currentTurnId) {
    statusLine.textContent = 'Wait for your turn before rolling.';
    return;
  }
  ws.send(JSON.stringify({ type: 'rollDice', payload: { sides: 20 } }));
  statusLine.textContent = 'Dice cast! Waiting for everyone...';
});

beginMasterBtn.addEventListener('click', () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'claimMaster' }));
  beginMasterBtn.disabled = true;
  masterStatus.textContent = 'Requesting GM control...';
});

startGameBtn.addEventListener('click', () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'startGame' }));
  startGameBtn.disabled = true;
  masterStatus.textContent = 'Sending start request...';
});

viewFeedBtn.addEventListener('click', () => {
  showView('feed');
});

backToDiceBtn.addEventListener('click', () => {
  showView('dice');
});
