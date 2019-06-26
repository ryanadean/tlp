const socketIO = require('socket.io')
const EQParser = require('./eq-parser')
const date = require('date-and-time')
const _ = require('lodash')
const constants = require('./constants')
const winston = require('winston')
const parser = new EQParser()

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.simple(),
    transports: [
        new winston.transports.Console()
    ]
})

function sendRaidUpdateRequest(raids, clients) {
    _.each(raids, (raiders, raidLeader) => {
        _.each(clients, (client) => {
            if (client.raidLeader == raidLeader) {
                client.scoket.emit('update_raid_dump_request')
            }
        })
    })
}

function sendHeartbeatRequest(socket, ctx) {
    // Do some logging
    if (socket) { 
        socket.emit('heartbeat')
        logger.info(`heartbeat - clients: ${_.size(ctx.clients)}, raids: ${_.size(ctx.raids)}`)
    } else logger.info('heartbeat - no connected clients')
}

module.exports = class Socket {

    /* public params */
    clients = {}
    mergedData = {}
    mergedTimeline = {}
    stats = {}
    parsedCount = 0
    doSend = false
    raids = {}
    raiders = {}

    constructor(server) {
        this.server = server
    }

    listen(server) {
        server = server || this.server
        const io = socketIO(server)
        
        io.on('connect', (socket) => {
            logger.info(`client connected: ${socket.id}`)
            let heartbeat = setInterval(sendHeartbeatRequest, 30000, socket, this)
            this.clients[socket.id] = {
                socket: socket,
                subjects: {},
                clientTime: 0,
                clientOwner: null,
            }

            socket.on("disconnect", reason => logger.info(reason))
            sendHeartbeatRequest(socket, this)

            this.mergedData = parser.combineData(this.clients)
            this.stats = parser.calculate(this.mergedData)
            socket.emit('update_stats', this.stats)
            this.doSend = false


            setInterval((ctx) => {
                if (ctx.doSend) {
                    ctx.mergedData = parser.combineData(ctx.clients)
                    ctx.stats = parser.calculate(ctx.mergedData)
                    socket.emit('update_stats', ctx.stats)
                    sendHeartbeatRequest(socket, ctx)
                    ctx.doSend = false
                }
            }, 30000, this)

            socket.on('time-sync', (time) => {

                this.clients[socket.id].clientTime = date.subtract(new Date(), new Date(parseInt(time))).toSeconds()
                logger.info(`Client ${socket.id} time sync: ${this.clients[socket.id].clientTime}, client: ${time}, server: ${new Date()}`)
            })

            socket.on('set-client-owner', (owner) => {
                this.clients[socket.id].clientOwner = owner
            })

            socket.on('disconnect', () => {
                heartbeat = null
                delete this.clients[socket.id]
                logger.info(`Client ${socket.id} disconnected`)
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
                let ctx = this
                let rLeader = _.find(raiders, (r) => (r.role == constants.raidRoles.raidLeader))
                logger.info(rLeader.name)
                // Handle oddities
                if (rLeader) {
                    // First find all raids that aren't led by this raid leader
                    let otherRaids = {}
                    _.each(ctx.raids, (raid, otherRaidLeader) => {
                        if (otherRaidLeader != rLeader.name ) otherRaids[otherRaidLeader] = raid
                    })

                    let raidsToInvalidate = {}
                    // Make sure this raid leader isn't a member of another raid
                    _.each(otherRaids, (raid, otherRaidLeader) => {
                        if (_.find(raid, (r) => (r.name != rLeader.name))) raidsToInvalidate[otherRaidLeader] = raid

                    })

                    // Make sure other raid leaders aren't in this raid as a non-leader
                    _.each(otherRaids, (raid, otherRaidLeader) => {
                        if (_.find(raiders), (r) => (r.name == otherRaidLeader && r.role != constants.raidRoles.raidLeader)) raidsToInvalidate[otherRaidLeader] = raid
                    })

                    // Invalidate the other raids
                    sendRaidUpdateRequest(otherRaids, ctx.clients)

                    _.each(otherRaids, (or, orl) => {
                        if (ctx.raids[orl]) {
                            _.each(or, (oraider) => {
                                if (ctx.raiders[oraider]) delete ctx.raiders[oraider]
                            })   
                            delete ctx.raids[orl]
                        }
                    })

                    _.each(raiders, (v, r) => {
                        // No matter what, we are going to put the raiders in this raid
                        ctx.raiders[r] = rLeader.name
                    })

                    // And update the raid for the raid leader
                    ctx.raids[rLeader.name] = raiders
                    socket.emit('update_raids', ctx.raids)
                }
            })

            socket.on('update_raid_leader', (leader) => {
                this.clients[socket.id].raidLeader = leader
            })
        });

    }
}