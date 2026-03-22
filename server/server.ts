import http from 'http';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { Game } from './engine/Game';
import {
  ClientMessage,
  ClientJoinMessage,
  ClientClaimMasterMessage,
  ClientStartGameMessage,
  ClientMoveMessage,
  ClientRollDiceMessage,
  ClientScriptActionMessage,
  ClientChooseOptionMessage,
  ServerMessage,
  ServerStateMessage,
  ServerIdMessage,
  ServerDiceMessage,
  ServerScriptMessage,
  ServerSceneMessage,
  ServerErrorMessage,
  Script,
} from '../shared/types';

const PORT = Number(process.env.PORT ?? 3000);
const server = http.createServer(async (req, res) => {
  const url = req.url ?? '/';
  try {
    if (url === '/' || url === '/index.html') {
      const html = await readFile(join(process.cwd(), 'client', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      return;
    }

    if (url === '/styles.css') {
      const css = await readFile(join(process.cwd(), 'client', 'styles.css'));
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end(css);
      return;
    }

    if (url.startsWith('/build/')) {
      const assetPath = join(process.cwd(), 'client', url);
      try {
        const data = await readFile(assetPath);
        const ext = assetPath.endsWith('.js') ? 'application/javascript' : 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': ext });
        res.end(data);
        return;
      } catch {
        // fall through to 404
      }
    }
  } catch (err) {
    console.warn('Failed to serve asset', url, err);
  }

  res.writeHead(404);
  res.end('Not Found');
});

const wss = new WebSocketServer({ server });
const game = new Game();
const storyScript: Script = {
  scenes: [
    {
      id: 'start',
      text: 'You enter a dimly lit cave.',
      options: [
        { text: 'Go left', goto: 'left_path' },
        { text: 'Go right', goto: 'right_path' },
      ],
      dice: false,
    },
    {
      id: 'left_path',
      text: 'The left path narrows and you see a chasm.',
      options: [{ text: 'Jump across', goto: 'jump' }, { text: 'Return', goto: 'start' }],
      dice: true,
      roll: { count: 1, type: 'd20' },
      success: 'You leap across safely.',
      fail: 'You lose your footing and step back.',
    },
    {
      id: 'right_path',
      text: 'The right path is lined with crystals, there is a fork ahead.',
      options: [{ text: 'Follow crystals', goto: 'crystals' }],
      dice: false,
    },
    {
      id: 'jump',
      text: 'You leap across safely.',
      options: [],
      dice: false,
    },
    {
      id: 'crystals',
      text: 'The crystals sparkle, revealing a hidden passage.',
      options: [{ text: 'Enter passage', goto: 'passage' }],
      dice: false,
    },
    {
      id: 'passage',
      text: 'You find a treasure chest.',
      options: [],
      dice: false,
    },
  ],
};

game.loadScript(storyScript);

const broadcast = (message: ServerMessage) => {
  const payload = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
};

const broadcastState = () => {
  const stateMessage: ServerStateMessage = { type: 'state', payload: game.getState() };
  broadcast(stateMessage);
};

const broadcastScene = () => {
  const state = game.getState();
  const sceneMessage: ServerSceneMessage = {
    type: 'sceneUpdate',
    payload: {
      sceneId: state.currentSceneId ?? '',
      text: state.currentText,
      options: state.availableOptions,
      diceRollRequired: state.diceRollRequired,
    },
  };
  broadcast(sceneMessage);
};

const sendError = (socket: WebSocket, reason: string) => {
  const message: ServerErrorMessage = { type: 'error', payload: { message: reason } };
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
};

wss.on('connection', (socket) => {
  const playerId = randomUUID();
  socket.send(JSON.stringify({ type: 'id', payload: { playerId } } as ServerIdMessage));

  let joined = false;

  const ensurePlayer = () => {
    if (joined && !game.hasPlayer(playerId)) {
      joined = false;
    }
    return joined;
  };

  socket.on('message', (raw) => {
    let message: ClientMessage;
    try {
      message = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      sendError(socket, 'Malformed message');
      return;
    }

    switch (message.type) {
      case 'join': {
        const join = message as ClientJoinMessage;
        if (joined) {
          sendError(socket, 'Already joined as a player.');
          return;
        }
        if (game.getState().gameStarted) {
          sendError(socket, 'Game already started; new joins are closed.');
          return;
        }
        game.addPlayer(playerId, join.payload.displayName);
        joined = true;
        broadcastState();
        return;
      }
      case 'claimMaster': {
        if (!ensurePlayer()) {
          sendError(socket, 'Join before claiming the master seat.');
          return;
        }
        const success = game.claimMaster(playerId);
        if (!success) {
          sendError(socket, 'There is already a master.');
          return;
        }
        broadcastState();
        return;
      }
      case 'startGame': {
        if (!ensurePlayer()) {
          sendError(socket, 'Join before starting the game.');
          return;
        }
        if (game.getState().masterId !== playerId) {
          sendError(socket, 'Only the master may start the game.');
          return;
        }
        if (!game.startGame()) {
          sendError(socket, 'Unable to start (game already started or no players).');
          return;
        }
        broadcastScene();
        broadcastState();
        return;
      }
      case 'move': {
        if (!ensurePlayer()) {
          sendError(socket, 'You must join before moving.');
          return;
        }
        const move = message as ClientMoveMessage;
        game.movePlayer(playerId, move.payload.direction);
        broadcastState();
        return;
      }
      case 'rollDice': {
        if (!ensurePlayer()) {
          sendError(socket, 'You must join before rolling dice.');
          return;
        }
        const diceResult = game.rollForPlayer(playerId);
        if (!diceResult) {
          sendError(socket, 'Not your turn or game not started.');
          return;
        }
        const diceMessage: ServerDiceMessage = {
          type: 'diceResult',
          payload: {
            playerId,
            sides: diceResult.sides,
            quantity: diceResult.quantity,
            rolls: diceResult.rolls,
            total: diceResult.total,
          },
        };
        broadcast(diceMessage);
        broadcastState();
        return;
      }
      case 'scriptAction': {
        if (!ensurePlayer()) {
          sendError(socket, 'You must join before advancing scripts.');
          return;
        }
        const script = message as ClientScriptActionMessage;
        const progress = game.runScriptAction(
          playerId,
          script.payload.scriptId,
          script.payload.step
        );
        if (progress) {
          const scriptMessage: ServerScriptMessage = {
            type: 'scriptUpdate',
            payload: {
              playerId,
              scriptId: progress.scriptId,
              step: progress.step,
              message: progress.message,
            },
          };
          broadcast(scriptMessage);
        }
        broadcastScene();
        broadcastState();
        return;
      }
      case 'chooseOption': {
        if (!ensurePlayer()) {
          sendError(socket, 'Join before choosing an option.');
          return;
        }
        if (!game.getState().gameStarted) {
          sendError(socket, 'Game has not started yet.');
          return;
        }
        const choose = message as ClientChooseOptionMessage;
        const scene = game.chooseOption(playerId, choose.payload.optionIndex);
        if (!scene) {
          sendError(socket, 'Invalid scene choice or not your turn.');
          return;
        }
        broadcastScene();
        broadcastState();
        return;
      }
      default:
        sendError(socket, 'Unknown message type');
    }
  });

  socket.on('close', () => {
    if (joined) {
      game.removePlayer(playerId);
      broadcastState();
    }
  });
});

server.listen(PORT, () => {
  console.log(`DnD server listening on http://localhost:${PORT}`);
});
