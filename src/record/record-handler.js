'use strict'

const C = require('../constants/constants')
const SubscriptionRegistry = require('../utils/subscription-registry').default
const ListenerRegistry = require('../listen/listener-registry')
const RecordTransition = require('./record-transition')
const RecordDeletion = require('./record-deletion')
const recordRequest = require('./record-request')

module.exports = class RecordHandler {
/**
 * The entry point for record related operations
 *
 * @param {Object} options deepstream options
 */
  constructor (options, subscriptionRegistry, listenerRegistry, metaData) {
    this._metaData = metaData
    this._options = options
    this._subscriptionRegistry =
    subscriptionRegistry || new SubscriptionRegistry(options, C.TOPIC.RECORD)
    this._listenerRegistry =
    listenerRegistry || new ListenerRegistry(C.TOPIC.RECORD, options, this._subscriptionRegistry)
    this._subscriptionRegistry.setSubscriptionListener(this._listenerRegistry)
    this._transitions = {}
    this._recordRequestsInProgress = {}
  }

/**
 * Handles incoming record requests.
 *
 * Please note that neither CREATE nor READ is supported as a
 * client send action. Instead the client sends CREATEORREAD
 * and deepstream works which one it will be
 *
 * @param   {SocketWrapper} socketWrapper the sender
 * @param   {Object} message parsed and validated deepstream message
 *
 * @public
 * @returns {void}
 */
  handle (socketWrapper, message) {
    if (message.action === C.ACTIONS.CREATEORREAD) {
    /*
     * Return the record's contents and subscribes for future updates.
     * Creates the record if it doesn't exist
     */
      this._createOrRead(socketWrapper, message)
    } else if (message.action === C.ACTIONS.CREATEANDUPDATE) {
    /*
     * Allows updates to the record without being subscribed, creates
     * the record if it doesn't exist
     */
      this._createAndUpdate(socketWrapper, message)
    } else if (message.action === C.ACTIONS.SNAPSHOT) {
    /*
     * Return the current state of the record in cache or db
     */
      this._snapshot(socketWrapper, message)
    } else if (message.action === C.ACTIONS.HEAD) {
    /*
     * Return the current state of the record in cache or db
     */
      this._head(socketWrapper, message)
    } else if (message.action === C.ACTIONS.HAS) {
    /*
     * Return a Boolean to indicate if record exists in cache or database
     */
      this._hasRecord(socketWrapper, message)
    } else if (message.action === C.ACTIONS.UPDATE || message.action === C.ACTIONS.PATCH) {
    /*
     * Handle complete (UPDATE) or partial (PATCH) updates
     */
      this._update(socketWrapper, message)
    } else if (message.action === C.ACTIONS.DELETE) {
    /*
     * Deletes the record
     */
      this._delete(socketWrapper, message)
    } else if (message.isAck && message.action === C.ACTIONS.DELETE) {
    /*
     * Handle delete acknowledgement from message bus
     * TODO: Different action
     */
      this._deleteAck(socketWrapper, message)
    } else if (message.action === C.ACTIONS.UNSUBSCRIBE) {
  /*
   * Unsubscribes (discards) a record that was previously subscribed to
   * using read()
   */
      this._subscriptionRegistry.unsubscribe(message, socketWrapper)
    } else if (message.action === C.ACTIONS.LISTEN ||
  /*
   * Listen to requests for a particular record or records
   * whose names match a pattern
   */
    message.action === C.ACTIONS.UNLISTEN ||
    message.action === C.ACTIONS.LISTEN_ACCEPT ||
    message.action === C.ACTIONS.LISTEN_REJECT) {
      this._listenerRegistry.handle(socketWrapper, message)
    } else {
  /*
   * Default for invalid messages
   */
      this._options.logger.warn(C.EVENT.UNKNOWN_ACTION, message.action, this._metaData)
    }
  }

/**
 * Tries to retrieve the record from the cache or storage. If not found in either
 * returns false, otherwise returns true.
 *
 * @param   {SocketWrapper} socketWrapper the socket that send the request
 * @param   {Object} message parsed and validated message
 *
 * @private
 * @returns {void}
 */
  _hasRecord (socketWrapper, message) {
    function onComplete (record, recordName, socket) {
      socket.sendMessage({
        topic: C.TOPIC.RECORD,
        action: C.ACTIONS.HAS,
        name: recordName,
        parsedData: !!record
      })
    }

    function onError (event, errorMessage, recordName, socket) {
      socket.sendError(message, event)
    }

    recordRequest(
      message.name,
      this._options,
      socketWrapper,
      onComplete,
      onError,
      this,
      this._metaData
    )
  }

/**
 * Sends the records data current data once loaded from the cache, and null otherwise
 *
 * @param {SocketWrapper} socketWrapper the socket that send the request
 * @param   {Object} message parsed and validated message
 * @private
 * @returns {void}
 */
  _snapshot (socketWrapper, message) {
    const onComplete = function (record, recordName, socket) {
      if (record) {
        sendRecord(recordName, record, socket)
      } else {
        socket.sendError(message, C.EVENT.RECORD_NOT_FOUND)
      }
    }
    const onError = function (event, errorMessage, recordName, socket) {
      socket.sendError(message, event)
    }

    recordRequest(
      message.name,
      this._options,
      socketWrapper,
      onComplete,
      onError,
      this,
      this._metaData
    )
  }

/**
 * Similar to snapshot, but will only return the current version number
 *
 * @param {SocketWrapper} socketWrapper the socket that send the request
 * @param   {Object} message parsed and validated message
 * @private
 * @returns {void}
 */
  _head (socketWrapper, message) {
    const onComplete = function (record, recordName, socket) {
      if (record) {
        socket.sendMessage({
          topic: C.TOPIC.RECORD,
          action: C.ACTIONS.HEAD,
          name: recordName,
          version: record._v
        })
      } else {
        socket.sendError(message, C.EVENT.RECORD_NOT_FOUND)
      }
    }
    const onError = function (event, errorMessage, recordName, socket) {
      socket.sendError(message, event)
    }

    recordRequest(
      message.name,
      this._options,
      socketWrapper,
      onComplete,
      onError,
      this,
      this._metaData
    )
  }


/**
 * Tries to retrieve the record and creates it if it doesn't exist. Please
 * note that create also triggers a read once done
 *
 * @param   {SocketWrapper} socketWrapper the socket that send the request
 * @param   {Object} message parsed and validated message
 *
 * @private
 * @returns {void}
 */
  _createOrRead (socketWrapper, message) {
    const onComplete = function (record, recordName, socket) {
      if (record) {
        this._read(message, record, socket)
      } else {
        this._permissionAction(
          C.ACTIONS.CREATE,
          recordName,
          socket,
          this._create.bind(this, message, socket)
        )
      }
    }

    recordRequest(
      message.name,
      this._options,
      socketWrapper,
      onComplete,
      () => {},
      this,
      this._metaData
    )
  }

/**
 * An upsert operation where the record will be created and written to
 * with the data in the message. Important to note that each operation,
 * the create and the write are permissioned separately.
 *
 * This method also takes note of the storageHotPathPatterns option, when a record
 * with a name that matches one of the storageHotPathPatterns is written to with
 * the CREATEANDUPDATE action, it will be permissioned for both CREATE and UPDATE, then
 * inserted into the cache and storage.
 *
 * @param   {SocketWrapper} socketWrapper the socket that send the request
 * @param   {Object} message parsed and validated message
 *
 * @private
 * @returns {void}
 */
  _createAndUpdate (socketWrapper, message) {
    const recordName = message.name
    const isPatch = message.path !== null
    message = Object.assign({}, message, { action: isPatch ? C.ACTIONS.PATCH : C.ACTIONS.UPDATE })

    // allow writes on the hot path to bypass the record transition
    // and be written directly to cache and storage
    for (let i = 0; i < this._options.storageHotPathPatterns.length; i++) {
      const pattern = this._options.storageHotPathPatterns[i]
      if (recordName.indexOf(pattern) !== -1 && !isPatch) {
        this._permissionAction(C.ACTIONS.CREATE, recordName, socketWrapper, () => {
          this._permissionAction(C.ACTIONS.UPDATE, recordName, socketWrapper, () => {
            this._forceWrite(recordName, message, socketWrapper)
          })
        })
        return
      } else if (isPatch) {
        socketWrapper.sendError(message, C.EVENT.INVALID_PATCH_ON_HOTPATH)
        return
      }
    }

    const transition = this._transitions[recordName]
    if (transition) {
      this._permissionAction(message.action, recordName, socketWrapper, () => {
        transition.add(socketWrapper, message)
      })
      return
    }

    this._permissionAction(C.ACTIONS.CREATE, recordName, socketWrapper, () => {
      this._permissionAction(C.ACTIONS.UPDATE, recordName, socketWrapper, () => {
        this._update(socketWrapper, message, true)
      })
    })
  }

/**
 * Forcibly writes to the cache and storage layers without going via
 * the RecordTransition. Usually updates and patches will go via the
 * transition which handles write acknowledgements, however in the
 * case of a hot path write acknowledgement we need to handle that
 * case here.
 *
 * @param  {String} recordName the name of the record being updated
 * @param  {Object} message the update message
 * @param  {SocketWrapper} socketWrapper the socket that sent the request
 *
 * @private
 * @returns {void}
 */
  _forceWrite (recordName, message, socketWrapper) {
    socketWrapper.parseData(message)
    const record = { _v: 0, _d: message.parsedData }
    const writeAck = message.requiresWriteAck
    let cacheResponse = false
    let storageResponse = false
    let writeError
    this._options.storage.set(recordName, record, (error) => {
      if (writeAck) {
        storageResponse = true
        writeError = writeError || error || null
        this._handleForceWriteAcknowledgement(
          socketWrapper, message, cacheResponse, storageResponse, writeError
        )
      }
    }, this._metaData)

    this._options.cache.set(recordName, record, (error) => {
      if (!error) {
        this._$broadcastUpdate(recordName, message, false, socketWrapper)
      }
      if (writeAck) {
        cacheResponse = true
        writeError = writeError || error || null
        this._handleForceWriteAcknowledgement(
        socketWrapper, message, cacheResponse, storageResponse, writeError
      )
      }
    }, this._metaData)
  }

/**
 * Handles write acknowledgements during a force write. Usually
 * this case is handled via the record transition.
 *
 * @param  {SocketWrapper} socketWrapper the socket that sent the request
 * @param  {Object} message the update message
 * @param  {Boolean} cacheResponse flag indicating whether the cache has been set
 * @param  {Boolean} storageResponse flag indicating whether the storage layer
 *                                   has been set
 * @param  {String} error any errors that occurred during writing to cache
 *                        and storage
 *
 * @private
 * @returns {void}
 */
  static _handleForceWriteAcknowledgement (
    socketWrapper, message, cacheResponse, storageResponse, error
  ) {
    if (storageResponse && cacheResponse) {
      socketWrapper.sendMessage({
        topic: C.TOPIC.RECORD,
        action: C.ACTIONS.WRITE_ACKNOWLEDGEMENT,
        name: message.name,
        data: [message.version, error]
      }, true)
    }
  }

/**
 * Creates a new, empty record and triggers a read operation once done
 *
 * @param   {String} recordName the name of the record to create
 * @param   {SocketWrapper} socketWrapper the socket that send the request
 * @param   {Function} callback optional callback that is fired when record
 *                              is set in cache
 * @private
 * @returns {void}
 */
  _create (message, socketWrapper, callback) {
    const recordName = message.name
    const record = { _v: 0, _d: {} }

    // store the records data in the cache and wait for the result
    this._options.cache.set(recordName, record, (error) => {
      if (error) {
        this._options.logger.error(C.EVENT.RECORD_CREATE_ERROR, recordName, this._metaData)
        socketWrapper.sendError(message, C.EVENT.RECORD_CREATE_ERROR)
      } else if (callback) {
        callback(recordName, socketWrapper)
      } else {
        this._read(message, record, socketWrapper)
      }
    }, this._metaData)

    if (!this._options.storageExclusion || !this._options.storageExclusion.test(recordName)) {
    // store the record data in the persistant storage independently and don't wait for the result
      this._options.storage.set(recordName, record, (error) => {
        if (error) {
          this._options.logger.error(C.EVENT.RECORD_CREATE_ERROR, `storage:${error}`, this._metaData)
        }
      }, this._metaData)
    }
  }

/**
 * Subscribes to updates for a record and sends its current data once done
 *
 * @param {String} recordName
 * @param {Object} record
 * @param {SocketWrapper} socketWrapper the socket that send the request
 *
 * @private
 * @returns {void}
 */
  _read (message, record, socketWrapper) {
    this._permissionAction(C.ACTIONS.READ, message.name, socketWrapper, () => {
      this._subscriptionRegistry.subscribe(message, socketWrapper)
      sendRecord(message.name, record, socketWrapper)
    })
  }

 /**
 * Applies both full and partial updates. Creates a new record transition that will live as
 * long as updates are in flight and new updates come in
 *
 * @param   {SocketWrapper} socketWrapper the socket that send the request
 * @param   {Object} message parsed and validated message
 * @param   {Boolean} upsert whether an upsert is possible
 *
 * @private
 * @returns {void}
 */
  _update (socketWrapper, message, upsert) {
    const recordName = message.name
    const version = message.version

  /*
   * If the update message is received from the message bus, rather than from a client,
   * assume that the original deepstream node has already updated the record in cache and
   * storage and only broadcast the message to subscribers
   */
    if (socketWrapper.isRemote) {
      this._$broadcastUpdate(recordName, message, false, socketWrapper)
      return
    }

    let transition = this._transitions[recordName]
    if (transition && transition.hasVersion(version)) {
      transition.sendVersionExists({ message, version, sender: socketWrapper })
      return
    }

    if (!transition) {
      transition = new RecordTransition(recordName, this._options, this, this._metaData)
      this._transitions[recordName] = transition
    }

    transition.add(socketWrapper, message, upsert)
  }

/**
 * Invoked by RecordTransition. Notifies local subscribers and other deepstream
 * instances of record updates
 *
 * @param   {String} name           record name
 * @param   {Object} message        parsed and validated deepstream message
 * @param   {Boolean} noDelay       Flag as to wether event allows delay
 * @param   {SocketWrapper} originalSender the socket the update message was received from
 *
 * @package private
 * @returns {void}
 */
  _$broadcastUpdate (name, message, noDelay, originalSender) {
    this._subscriptionRegistry.sendToSubscribers(name, message, noDelay, originalSender)
  }

/**
 * Called by a RecordTransition, either if it is complete or if an error occured. Removes
 * the transition from the registry
 *
 * @todo  refactor - this is a bit of a mess
 * @param   {String} recordName record name
 *
 * @package private
 * @returns {void}
 */
  _$transitionComplete (recordName) {
    delete this._transitions[recordName]
  }

/**
 * Executes or schedules a callback function once all transitions are complete
 *
 * This is called from the PermissionHandler destroy method, which
 * could occur in cases where 'runWhenRecordStable' is never called,
 * such as when no cross referencing or data loading is used.
 *
 * @param   {String}   recordName the name of the record
 *
 * @private
 * @returns {void}
 */
  removeRecordRequest (recordName) {
    if (!this._recordRequestsInProgress[recordName]) {
      return
    }

    if (this._recordRequestsInProgress[recordName].length === 0) {
      delete this._recordRequestsInProgress[recordName]
      return
    }

    const callback = this._recordRequestsInProgress[recordName].splice(0, 1)[0]
    callback(recordName)
  }

/**
 * Executes or schedules a callback function once all record requests are removed.
 * This is critical to block reads until writes have occured for a record, which is
 * only from permissions when a rule is required to be run and the cache has not
 * verified it has the latest version
 *
 * @param   {String}   recordName the name of the record
 * @param   {Function} callback   function to be executed once all writes to this record
 *                                are complete
 *
 * @public
 * @returns {void}
 */
  runWhenRecordStable (recordName, callback) {
    if (
    !this._recordRequestsInProgress[recordName] ||
    this._recordRequestsInProgress[recordName].length === 0
  ) {
      this._recordRequestsInProgress[recordName] = []
      callback(recordName)
    } else {
      this._recordRequestsInProgress[recordName].push(callback)
    }
  }

/**
 * Deletes a record. If a transition is in progress it will be stopped. Once the deletion is
 * complete, an ACK is returned to the sender and broadcast to the message bus.
 *
 * @param   {SocketWrapper} socketWrapper the socket that send the request
 * @param   {Object}        message       parsed and validated message
 *
 * @private
 * @returns {void}
 */
  _delete (socketWrapper, message) {
    const recordName = message.name

    if (this._transitions[recordName]) {
      this._transitions[recordName].destroy()
      delete this._transitions[recordName]
    }

  // eslint-disable-next-line
  new RecordDeletion(this._options, socketWrapper, message, this._onDeleted.bind(this), this._metaData)
  }

/**
 * Handle a record deletion ACK from the message bus. We assume that the original deepstream node
 * has already deleted the record from cache and storage and we only need to broadcast the message
 * to subscribers.
 *
 * If a transition is in progress it will be stopped.
 *
 * @param   {SocketWrapper} socketWrapper the socket that send the request
 * @param   {Object}        message       parsed and validated message
 *
 * @private @returns {void}
 */
  _deleteAck (socketWrapper, message) {
    const recordName = message.name

    if (this._transitions[recordName]) {
      this._transitions[recordName].destroy()
      delete this._transitions[recordName]
    }

    this._onDeleted(recordName, message, socketWrapper)
  }

/*
 * Callback for completed deletions. Notifies subscribers of the delete and unsubscribes them
 *
 * @param   {String} name           record name
 * @param   {Object} message        parsed and validated deepstream message
 * @param   {SocketWrapper} originalSender the socket the update message was received from
 *
 * @package private
 * @returns {void}
 */
  _onDeleted (name, message, originalSender) {
    this._$broadcastUpdate(name, message, true, originalSender)

    for (const subscriber of this._subscriptionRegistry.getLocalSubscribers(name)) {
      this._subscriptionRegistry.unsubscribe(message, subscriber, true)
    }
  }

/**
 * A secondary permissioning step that is performed once we know if the record exists (READ)
 * or if it should be created (CREATE)
 *
 * @param   {String} action          One of C.ACTIONS, either C.ACTIONS.READ or C.ACTIONS.CREATE
 * @param   {String} recordName      The name of the record
 * @param   {SocketWrapper} socketWrapper the socket that send the request
 * @param   {Function} successCallback A callback that will only be invoked if the operation was
 *                                     successful
 *
 * @private
 * @returns {void}
 */
  _permissionAction (action, recordName, socketWrapper, successCallback) {
    const message = {
      topic: C.TOPIC.RECORD,
      action,
      name: recordName
    }

    this._options.permissionHandler.canPerformAction(
      socketWrapper.user,
      message,
      onPermissionResponse.bind(this, socketWrapper, message, successCallback),
      socketWrapper.authData,
      socketWrapper
    )
  }

}

/*
 * Callback for complete permissions. Notifies socket if permission has failed
 */
function onPermissionResponse (socketWrapper, message, successCallback, error, canPerformAction) {
  if (error !== null) {
    this._options.logger.error(C.EVENT.MESSAGE_PERMISSION_ERROR, error.toString())
    socketWrapper.sendError(message, C.EVENT.MESSAGE_PERMISSION_ERROR)
  } else if (canPerformAction !== true) {
    socketWrapper.sendError(message, C.EVENT.MESSAGE_DENIED)
  } else {
    successCallback()
  }
}

  /**
 * Sends the records data current data once done
 *
 * @param {String} recordName
 * @param {Object} record
 * @param {SocketWrapper} socketWrapper the socket that send the request
 *
 * @private
 * @returns {void}
 */
function sendRecord (recordName, record, socketWrapper) {
  socketWrapper.sendMessage({
    topic: C.TOPIC.RECORD,
    action: C.ACTIONS.READ,
    name: recordName,
    version: record._v,
    parsedData: record._d
  })
}
