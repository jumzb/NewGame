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
} from '../shared/types';

type View = 'intro' | 'dice' | 'feed';

interface Character {
  name: string;
  role: string;
}

interface ScenePayload {
  sceneId: string;
  text: string;
  options: SceneOption[];
  diceRollRequired: boolean;
}

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
        <input id="nameInput" type="text" placeholder="Bossman" required />
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
    <h2>Dice Ritual</h2>
    <p id="characterSummary" class="hint"></p>
    <article class="scene" id="scenePanel">
      <h3>Scene</h3>
      <p id="sceneText" class="scene-text hint">Waiting for the master to begin the tale.</p>
      <div id="sceneOptions" class="scene-options"></div>
      <p id="sceneDiceHint" class="hint"></p>
    </article>
    <div class="players">
      <h3>Current Players</h3>
      <ul id="playersList"></ul>
    </div>
    <p class="hint" id="turnLine"></p>
    <div class="master-controls">
      <button id="beginMasterBtn">Begin as master</button>
      <div id="masterPanel" class="hidden">
        <p class="hint" id="masterStatus"></p>
        <button id="startGameBtn">Start Game</button>
      </div>
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
const masterPanel = document.getElementById('masterPanel') as HTMLElement;
const masterStatus = document.getElementById('masterStatus') as HTMLElement;
const startGameBtn = document.getElementById('startGameBtn') as HTMLButtonElement;
const sceneText = document.getElementById('sceneText') as HTMLElement;
const sceneOptions = document.getElementById('sceneOptions') as HTMLElement;
const sceneDiceHint = document.getElementById('sceneDiceHint') as HTMLElement;

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
  latestScene = payload;
  sceneText.textContent = payload.text || 'The script is waiting for the master to proceed.';
  sceneOptions.innerHTML = '';
  const isCurrentPlayer = Boolean(
    latestState && latestState.gameStarted && latestState.currentTurnId === localId
  );
  if (payload.options.length) {
    if (isCurrentPlayer) {
      payload.options.forEach((option, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'scene-option';
        button.textContent = option.text;
        button.dataset.index = index.toString();
        sceneOptions.append(button);
      });
    } else {
      const placeholder = document.createElement('p');
      placeholder.className = 'hint';
      const waitingFor = getPlayerName(latestState?.currentTurnId ?? null);
      placeholder.textContent = `Waiting for ${waitingFor} to take their turn.`;
      sceneOptions.append(placeholder);
    }
  } else {
    const placeholder = document.createElement('p');
    placeholder.className = 'hint';
    placeholder.textContent = payload.diceRollRequired
      ? 'A dice roll will resolve this moment.'
      : 'No choices are available right now.';
    sceneOptions.append(placeholder);
  }
  sceneDiceHint.textContent = payload.diceRollRequired
    ? 'Dice rolls determine the outcome of this scene.'
    : 'Pick a path when it is your turn.';
  awaitingSceneUpdate = false;
  refreshChoiceAvailability();
};

const refreshChoiceAvailability = () => {
  const isCurrentTurn = Boolean(
    latestState && latestState.gameStarted && latestState.currentTurnId === localId
  );
  if (awaitingSceneUpdate) {
    sceneOptions.querySelectorAll('button').forEach((button) => {
      (button as HTMLButtonElement).disabled = true;
    });
    rollBtn.disabled = true;
    return;
  }
  sceneOptions.querySelectorAll('button').forEach((button) => {
    (button as HTMLButtonElement).disabled = !isCurrentTurn;
  });
  const diceRequired = latestScene?.diceRollRequired ?? false;
  rollBtn.hidden = !diceRequired || !latestScene;
  rollBtn.disabled = !isCurrentTurn || !diceRequired;
};

const updateSceneFromState = (state: GameState) => {
  if (!state.gameStarted) {
    latestScene = null;
    sceneText.textContent = 'Game will start once the master hits Start Game.';
    sceneOptions.innerHTML = '';
    sceneDiceHint.textContent = 'Join the table and wait for the master.';
    rollBtn.hidden = true;
    return;
  }
  updateSceneDisplay({
    sceneId: state.currentSceneId ?? '',
    text: state.currentText || 'Waiting for the story to unfold.',
    options: state.availableOptions,
    diceRollRequired: state.diceRollRequired,
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
  if (!latestState?.gameStarted || latestState.currentTurnId !== localId || awaitingSceneUpdate) {
    return;
  }
  sendChooseOption(Number(index));
});

const updateLobbyStatus = (state: GameState) => {
  if (!state.masterId) {
    statusLine.textContent = 'Connected. Waiting for a master to claim the seat.';
    return;
  }
  const masterName = getPlayerLabel(state.masterId);
  if (!state.gameStarted) {
    if (state.masterId === localId) {
      statusLine.textContent = 'You are the master. Start the game when ready.';
    } else {
      statusLine.textContent = `${masterName} is master. Waiting for them to start the game.`;
    }
    return;
  }
  statusLine.textContent = `Game in progress. ${masterName} is guiding the session.`;
};

const updateMasterControls = (state: GameState) => {
  const isMaster = state.masterId === localId;
  beginMasterBtn.disabled = !connected || (state.masterId !== null && !isMaster) || state.gameStarted;
  masterPanel.classList.toggle('hidden', !isMaster || state.gameStarted);
  if (isMaster && !state.gameStarted) {
    masterStatus.textContent = 'You control the table. Hit Start Game when ready.';
    startGameBtn.disabled = false;
  } else if (!state.masterId) {
    masterStatus.textContent = 'Claim the master seat to coordinate the table.';
    startGameBtn.disabled = true;
  } else {
    masterStatus.textContent = `${getPlayerLabel(state.masterId)} is master.`;
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

  currentTurnId = state.currentTurnId;
  nextTurnId = state.nextTurnId;
  updateTurnStatus(state);
  updateLobbyStatus(state);
  updateMasterControls(state);
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
    statusLine.textContent = 'Connected. Waiting for a master to claim the seat.';
    ws?.send(JSON.stringify({ type: 'join', payload: { displayName: name } }));
    showView('dice');
  });

  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data) as ServerMessage;

    switch (message.type) {
      case 'id': {
        const idMessage = message as ServerIdMessage;
        localId = idMessage.payload.playerId;
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

  character = { name, role };
  characterSummary.textContent = `You are ${name}, the ${role}.`;
  statusLine.textContent = 'Connecting...';
  connect(name);
});

rollBtn.disabled = true;
rollBtn.hidden = true;
beginMasterBtn.disabled = true;
startGameBtn.disabled = true;

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
  masterStatus.textContent = 'Requesting master control...';
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
