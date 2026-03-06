import { DeliverooApi } from "@unitn-asa/deliveroo-js-client";

console.log('Starting...');

const client = new DeliverooApi(
    'https://deliveroojs.onrender.com/',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjE5YWJjNSIsIm5hbWUiOiJhbm9ueW1vdXMiLCJyb2xlIjoidXNlciIsImlhdCI6MTc3MjgwMjIzM30.eNrKiGs8A9on0cfXWgrXvQFTjlLB9DZ72wAlRZqgQuw'
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

//myFn();

console.log('Listening for events...');

//tieni per dopo
client.on( 'tile', (tile) => {
    console.log('Tile:', tile);
} );

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
    myFn();
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