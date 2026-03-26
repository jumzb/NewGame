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
} from '../shared/types';

const PORT = Number(process.env.PORT ?? 3000);
const readRequestBody = (req: http.IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });

const sendJsonResponse = (
  res: http.ServerResponse,
  status: number,
  payload: Record<string, unknown>
) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
};
const server = http.createServer(async (req, res) => {
  const url = req.url ?? '/';

  if (req.method === 'POST' && url === '/upload-script') {
    if (!game.getState().masterId) {
      sendJsonResponse(res, 400, { error: 'Claim the master seat before uploading a script.' });
      return;
    }
    if (game.getState().gameStarted) {
      sendJsonResponse(res, 400, { error: 'Game already started; cannot replace the script.' });
      return;
    }
    let payloadText: string;
    try {
      payloadText = await readRequestBody(req);
    } catch (err) {
      sendJsonResponse(res, 400, { error: 'Unable to read upload payload.' });
      return;
    }
    let payload: Record<string, any>;
    try {
      payload = JSON.parse(payloadText);
    } catch (err) {
      sendJsonResponse(res, 400, { error: 'Upload body must be valid JSON.' });
      return;
    }
    const { filename, script, playerId } = payload;
    if (!playerId || playerId !== game.getState().masterId) {
      sendJsonResponse(res, 403, { error: 'Only the master can upload the script.' });
      return;
    }
    if (typeof filename !== 'string' || !filename.toLowerCase().endsWith('.rpgjson')) {
      sendJsonResponse(res, 400, { error: 'Script must have a .rpgjson extension.' });
      return;
    }
    if (!script || typeof script !== 'object') {
      sendJsonResponse(res, 400, { error: 'Script payload must be an object.' });
      return;
    }
    try {
      game.loadScript(script, filename);
      broadcastScenes();
      broadcastState();
      sendJsonResponse(res, 200, { status: 'Script uploaded successfully.' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Script validation failed.';
      sendJsonResponse(res, 400, { error: message });
    }
    return;
  }
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

const buildSceneMessage = (playerId: string): ServerSceneMessage | null => {
  const sceneState = game.getPlayerSceneState(playerId);
  if (!sceneState) return null;
  return {
    type: 'sceneUpdate',
    payload: {
      playerId,
      sceneId: sceneState.sceneId,
      text: sceneState.sceneText,
      options: sceneState.availableOptions,
      diceRollRequired: sceneState.diceRollRequired,
    },
  };
};

const broadcastSceneForPlayer = (playerId: string) => {
  const sceneMessage = buildSceneMessage(playerId);
  if (!sceneMessage) return;
  broadcast(sceneMessage);
};

const broadcastScenes = () => {
  const state = game.getState();
  Object.keys(state.playerScenes).forEach(broadcastSceneForPlayer);
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
        if (!game.getState().scriptLoaded) {
          sendError(socket, 'Upload a .rpgjson script before starting.');
          return;
        }
        if (!game.startGame()) {
          sendError(socket, 'Unable to start (game already started or no players).');
          return;
        }
        broadcastScenes();
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
        broadcastSceneForPlayer(playerId);
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
          const result = game.chooseOption(playerId, choose.payload.optionIndex);
          if (!result) {
            sendError(socket, 'Invalid scene choice or game not started.');
            return;
          }
          if (result.flagsUpdated) {
            broadcastScenes();
          } else {
            broadcastSceneForPlayer(playerId);
          }
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
