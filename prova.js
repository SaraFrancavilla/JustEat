// {
//   "name": "project",
//   "version": "1.0.0",
//   "description": "",
//   "main": "prova.js",
//   "type": "module",
//   "scripts": {
//     "test": "echo \"Error: no test specified\" && exit 1"
//   },
//   "author": "",
//   "license": "ISC",
//   "dependencies": {
//     "@unitn-asa/deliveroo-js-client": "^2.0.3",
//     "@types/pddl-client": "^1.6.2"
//   }
// }



import { DeliverooApi } from "@unitn-asa/deliveroo-js-client";

console.log('Starting...');

const client = new DeliverooApi(
    'https://deliveroojs.onrender.com/',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjQ3YTkzZiIsIm5hbWUiOiJhbm9ueW1vdXMiLCJyb2xlIjoidXNlciIsImlhdCI6MTc3MzE0MDEwOX0.AEvBAG9d6r8w73iP1h9TXn9llX8jINYZSH1AnNmOnDs'
)

async function myFn () {

    let up = await client.emitMove('up');
    console.log('Move up result:', up);

    let left = await client.emitMove('left');
    console.log('Move left result:', left);

    let down = await client.emitMove('down');
    console.log('Move down result:', down);

    let right = await client.emitMove('right');

    console.log('Move right result:', right);

    // let right = await client.emitMove('right');
    // console.log('Move right result:', right);
    
}

var savedTiles = {};

async function percepting(){

    console.log('Starting percepting...');

    //save the tiles the agent is on, 
    // to use it later for exploration
    // client.onTile((tile) => {
    //     if (!(tile in savedTiles)) {
    //         savedTiles[tile] = true;
    //     }
    // });

    //save what the agent sees in the map, 
    // to use it later for exploration
    // client.onMap((map) => {
    //     console.log('Map received:', map);
    // });

    //troppo tardi
    client.onTile((tile) => {
        console.log('Agent on Tile:', tile);
    });
}

//myFn();

console.log('Listening for events...');

//ritorna tutto quello che l'agente vede, 
// anche se non è più in movimento,
client.onMap((x, y, tiles) => {
    console.log('Map received:', x, y, tiles);
});

// client.onParcelsSensing((parcels) => {
//     console.log('Parcels sensed:', parcels);
// });

//per capire quanti agenti ci sono nella mappa
client.onAgentConnected((socketId, agent) => {
    console.log('Agent connected:', agent);
    console.log('socketID:', socketId);
});

//controllo chi sono io
client.onceYou(async (me) => {
    console.log('My agent ready:', me);
});

//con async continua a farlo all'infinito
//funziona e si muove
//qundo viene staccato e riattaccato smette di funzionare, 
// non riceve più eventi
client.onYou(async (me) => {
    //myFn();
    //ritorna la posizione del mio agente
    console.log('Inside onYou event, my agent:', me);
    percepting();
    // const up =  await client.emitMove('up');
    // console.log('Move up ack (my agent):', up);
    // console.log('My position update:', me.x, me.y, 'score:', me.score);
});


//TODO:
//SVILUPPA UN ALGORITMO SEMPLICE DI ESPLORAZIONE
// SALVATAGGIO DELLE TILES
//SALVA OGGETTI E IL TEMPO DI SPAWN
//MIGLIORA ALGORITMO ESPLORATIVO: AGGIUNGI SCELTA DI PRESA OGGETTI 



/**
 * 28/03/2023
 * 
 * Implement an agent that:
 * - moves along a predefined path
 * - pick the parcel
 * - deliver it
 * 
 * What if other agents are moving?
 * - Dealing with failing actions, by insisting on path.

 */
