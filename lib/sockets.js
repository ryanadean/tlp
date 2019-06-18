const socketIO = require('socket.io')
const EQParser = require('./eq-parser')
const date = require('date-and-time')
const _ = require('lodash')

const parser = new EQParser()

module.exports = class Socket {

    /* public params */
    clients = []
    mergedData = {}
    mergedTimeline = {}
    stats = {}
    parsedCount = 0
    doSend = false

    constructor(server) {

        this.server = server
    }

    listen(server) {
        server = server || this.server
        const io = socketIO(server, {transports: ["websocket"]})
        io.on('connect', (socket) => {
            console.log(`client connected: ${socket.id}`)
            this.clients[socket.id] = {
                socket: socket,
                subjects: {},
                clientTime: 0,
                clientOwner: null,
            }

            socket.on("disconnect", reason => console.log(reason))

            socket.emit('server-time-sync-request')

            this.mergedData = parser.combineData(this.clients)
            this.stats = parser.calculate(this.mergedData)
            socket.emit('update_stats', this.stats)
            this.doSend = false


            setInterval((ctx) => {
                if (ctx.doSend) {
                    ctx.mergedData = parser.combineData(ctx.clients)
                    ctx.stats = parser.calculate(ctx.mergedData)
                    socket.emit('update_stats', ctx.stats)
                    ctx.doSend = false
                }
            }, 30000, this)

            socket.on('time-sync', (time) => {
                this.clients[socket.id].clientTime = date.subtract(new Date(), new Date(parseInt(time))).toSeconds()
            })

            socket.on('set-client-owner', (owner) => {
                this.clients[socket.id].clientOwner = owner
            })

            socket.on('disconnect', () => {
                delete this.clients[socket.id]
                console.log(`Client ${socket.id} disconnected`)
            })

            socket.on('logline', (line) => {
                if (this.clients[socket.id]) {
                    this.clients[socket.id] = parser.parse(line.public, this.clients[socket.id])
                    this.parsedCount++
                    if (this.parsedCount % 100 == 0) this.doSend = true
                }
            })

            socket.on('get-report-request', () => {
                this.mergedData = parser.combineData(this.clients)
                this.stats = parser.calculate(this.mergedData)
                socket.emit('update_stats', this.stats)
            })

            socket.on('raiddump', (raiders) => {

            })
        });

    }
}