//
//  privacyButton_server.js
//
//  Created by Rebecca Stankus on 0/09/19.
//  Copyright 2019 High Fidelity, Inc.
//
//  Distributed under the Apache License, Version 2.0.
//  See the accompanying file LICENSE or http://www.apache.org/licenses/LICENSE-2.0.html
//

(function() {

    var _this;

    var PRELOAD_DATA_RETRIEVAL_INTERAL_MS = 500;
    var PRELOAD_DATA_RETRIEVAL_MAX_ATTEMPTS = 10;

    var REPEAT_TRANSITION_CALL_TIMEOUT_MS = 500;

    var MOVEMENT_LOCAL_VELOCITY_M_PER_S = 0.5;
    var UPDATE_INTERVAL_MS = 70;
    var SHADE_HEIGHT_CHANGE_PER_INTERVAL_M = 0.05;
    
    var DONE_SOUND = SoundCache.getSound(Script.resolvePath("../../resources/sounds/DONE_SOUND.mp3"));
    var TRANSITION_SOUND = SoundCache.getSound(Script.resolvePath("../../resources/sounds/TRANSITION_SOUND.mp3"));
    var DONE_VOLUME = 0.2;
    var TRANSITION_VOLUME = 0.05;

    var DEFAULT_DOOR_CLOSED_LOCAL_POSITION = { x: 3.3128, y: 0.0749, z: -1.1508 };
    var DEFAULT_DOOR_OPEN_LOCAL_POSITION = { x: 3.5233, y: 0.0749, z: -2.3468 };
    var DEFAULT_SHADE_LOWERED_DIMENSIONS = { x: 6.7017, y: 2.3449, z: 6.8765 };
    var DEFAULT_SHADE_RAISED_DIMENSIONS = { x: 6.7017, y: 0.01, z: 6.8765 };
    var SHADE_TARGET_DEVIATION_ALLOWANCE = 0.005;
    var MAX_DISTANCE_TO_TRANSITION_ENTITIES_M = 10;
    var MIN_DISTANCE_TO_TRANSITION_ENTITIES_M = 0.1;

    var BUTTON_OPEN_COLOR = { red: 17, green: 17, blue: 17 };
    var BUTTON_CLOSED_COLOR = { red: 0, green: 86, blue: 214 };
    var BUTTON_TRANSITION_COLOR = { red: 153, green: 153, blue: 153 };

    var ready = false;
    var currentState = "open";
    var repeatTransitionCall = false;
    var repeatTransitionCallTimeout;

    var shade;
    var door;
    var button;
    var chatterbox;

    var updateInterval;
    var preloadDataRetrievalInterval;
    var preloadIntervalCount = 0;

    var shadeHeightChange = 0;

    var injector;
    var buttonPosition;

    var PrivacyButton = function() {
        _this = this;
    };

    PrivacyButton.prototype = {
        remotelyCallable: ['transition'],

        /* Begin trying to read entity properties to collect necessary data */
        preload: function(entityID) {
            _this.entityID = entityID;
            preloadDataRetrievalInterval = Script.setInterval(function() {
                _this.preloadSetupAttempt();
            }, PRELOAD_DATA_RETRIEVAL_INTERAL_MS);
        },

        /* Try to get entity data, if all data is able to be retrieved, set up entities in 'open' state.
         If more than 10 attempts are made, stop trying to read entity properties. */
        preloadSetupAttempt: function() {
            preloadIntervalCount++;
            try {
                _this.getEntityData();
            } catch (err) {
                print("Attempt ", preloadIntervalCount, " to get entity data failed.");
            }
            if (shade && door && button) {
                ready = true;
                Entities.editEntity(shade, {
                    dimensions: DEFAULT_SHADE_RAISED_DIMENSIONS,
                    visible: 0
                });
                Entities.editEntity(door, {
                    localPosition: DEFAULT_DOOR_OPEN_LOCAL_POSITION,
                    velocity: { x: 0, y: 0, z: 0 }
                });
                Entities.editEntity(button, {
                    color: BUTTON_OPEN_COLOR
                });
                if (preloadDataRetrievalInterval) {
                    Script.clearInterval(preloadDataRetrievalInterval);
                    preloadDataRetrievalInterval = null;
                }
            } else if (preloadIntervalCount >= PRELOAD_DATA_RETRIEVAL_MAX_ATTEMPTS) {
                if (preloadDataRetrievalInterval) {
                    Script.clearInterval(preloadDataRetrievalInterval);
                    preloadDataRetrievalInterval = null;
                }
            }
        },

        /* Use parenting relationships to get IDs of required entities */
        getEntityData: function() {
            if (!table) {
                var table = Entities.getEntityProperties(_this.entityID, 'parentID').parentID;
                Entities.getChildrenIDs(table).forEach(function(tableChildID) {
                    var properties = Entities.getEntityProperties(tableChildID, ['position', 'name']);
                    if (properties.name === "Chatterbox Privacy Button") {
                        button = tableChildID;
                        buttonPosition = properties.position;
                        chatterbox = Entities.getEntityProperties(table, 'parentID').parentID;
                    }
                });
            }
            if (chatterbox && (!door || !shade)) {
                Entities.getChildrenIDs(chatterbox).forEach(function(chatterboxChildID) {
                    var properties = Entities.getEntityProperties(chatterboxChildID, ['position', 'name']);
                    if (properties.name === "Chatterbox Door") {
                        door = chatterboxChildID;
                    } else if (properties.name === "Chatterbox Shade") {
                        shade = chatterboxChildID;
                    }
                });
            }
        },

        /* PLAY A SOUND: Plays a sound at the specified position, volume, local mode, and playback 
        mode requested. */
        playSound: function(sound, volume, position, localOnly, loop) {
            if (sound.downloaded) {
                if (injector) {
                    injector.stop();
                    injector = null;
                }
                injector = Audio.playSound(sound, {
                    position: position,
                    volume: volume,
                    localOnly: localOnly,
                    loop: loop
                });
            }
        },

        /* Toggle between between open and private chatterbox states.  */
        transition: function() {
            if (!ready || repeatTransitionCall) {
                return;
            }
            /* When the client script calls ths function, it is being received multiple times despite only one event 
            happening in the client. The repeattransitionCall variable handles that */
            repeatTransitionCall = true;
            repeatTransitionCallTimeout = Script.setTimeout(function() {
                repeatTransitionCall = false;
            }, REPEAT_TRANSITION_CALL_TIMEOUT_MS);

            if (updateInterval) {
                Script.clearInterval(updateInterval);
                updateInterval = null;
            }

            // Determine how entities need to change to get to the next state
            currentState = (currentState === "closed" || currentState === "toClosed") ? "toOpen" : "toClosed";
            var doorMovements = {};
            var shadeTargetHeight;
            if (currentState === "toClosed") {
                doorMovements.targetPosition = DEFAULT_DOOR_CLOSED_LOCAL_POSITION;
                shadeTargetHeight = DEFAULT_SHADE_LOWERED_DIMENSIONS.y;
                doorMovements.currentAxis = "z";
            } else {
                doorMovements.targetPosition = DEFAULT_DOOR_OPEN_LOCAL_POSITION;
                shadeTargetHeight = DEFAULT_SHADE_RAISED_DIMENSIONS.y;
                doorMovements.currentAxis = "x";
            }

            _this.setUpDoorMovements(doorMovements);

            // Determine if shade will raise or lower from its current position
            var shadeCurrentDimensions = Entities.getEntityProperties(shade, 'dimensions').dimensions;
            if (shadeCurrentDimensions.y !== shadeTargetHeight) {
                shadeHeightChange = shadeCurrentDimensions.y > shadeTargetHeight ? 
                    -SHADE_HEIGHT_CHANGE_PER_INTERVAL_M : SHADE_HEIGHT_CHANGE_PER_INTERVAL_M;
            }

            // If any entities will change, begin a transition period. If not, signal that we are in the next state
            if (doorMovements.xVelocity || doorMovements.zVelocity || shadeHeightChange !== 0) {
                Entities.editEntity(button, {
                    color: BUTTON_TRANSITION_COLOR
                });
            } else {
                _this.playSound(DONE_SOUND, DONE_VOLUME, buttonPosition, false, false);
                currentState = (currentState === "closed" || currentState === "toClosed") ? "open" : "closed";
                Entities.editEntity(button, {
                    color: currentState === "closed" ? BUTTON_CLOSED_COLOR : BUTTON_OPEN_COLOR
                });
                return;
            }
            
            _this.playSound(TRANSITION_SOUND, TRANSITION_VOLUME, buttonPosition, false, true);

            // Start door movement in whichever axis it should move along first
            if (doorMovements.xVelocity && doorMovements.currentAxis === "x") {
                Entities.editEntity(door, {
                    localVelocity:  { x: doorMovements.xVelocity, y: 0, z: 0 }
                });
            } else if (doorMovements.zVelocity && doorMovements.currentAxis === "z") {
                Entities.editEntity(door, {
                    localVelocity:  { x: 0, y: 0, z: doorMovements.zVelocity }
                });
            }
            
            // Make sure the shade is visible if beginning to close it
            if (currentState === "toClosed") {
                Entities.editEntity(shade, {
                    visible: true
                });
            }

            updateInterval = Script.setInterval(function() {
                _this.updateEntities(doorMovements, shadeTargetHeight);
            }, UPDATE_INTERVAL_MS);
        },

        /* Handle any odd scenarios where the door is not nearby or is already in place and then get data for how it will move*/
        setUpDoorMovements: function(doorMovements) {
            var doorCurrentLocalPosition = Entities.getEntityProperties(door, 'localPosition').localPosition;
            // If the door has somehow been moved far away, slam it into open position to avoid hitting anyone in the doorway
            if (Vec3.distance(doorCurrentLocalPosition, doorMovements.targetPosition) > MAX_DISTANCE_TO_TRANSITION_ENTITIES_M) {
                Entities.editEntity(door, {
                    localPosition: DEFAULT_DOOR_OPEN_LOCAL_POSITION
                });
            // If door is not aligned vertically, slam into correct vertical position
            } else if (doorCurrentLocalPosition.y !== DEFAULT_DOOR_CLOSED_LOCAL_POSITION.y) {
                doorCurrentLocalPosition = {
                    x: doorCurrentLocalPosition.x,
                    y: DEFAULT_DOOR_CLOSED_LOCAL_POSITION.y,
                    z: doorCurrentLocalPosition.z
                };
                Entities.editEntity(door, {
                    localPosition: doorCurrentLocalPosition
                });
            // If door is very close to correct position, slam into exact position
            } else {
                if (Vec3.distance(doorCurrentLocalPosition, doorMovements.targetPosition) <= 
                    MIN_DISTANCE_TO_TRANSITION_ENTITIES_M) {
                    Entities.editEntity(door, {
                        localPosition: DEFAULT_DOOR_OPEN_LOCAL_POSITION
                    });
                }
                doorCurrentLocalPosition = doorMovements.targetPosition;
            }
            _this.getDoorMovementData(doorMovements, doorCurrentLocalPosition);
        },

        /* Determine whether the door needs + or - velocity along each necessary axis to get to the target position */
        getDoorMovementData: function(doorMovements, doorCurrentLocalPosition) {
            if (doorCurrentLocalPosition.x !== doorMovements.targetPosition.x) {
                doorMovements.xVelocity = (doorCurrentLocalPosition.x > doorMovements.targetPosition.x) ? 
                    -MOVEMENT_LOCAL_VELOCITY_M_PER_S : MOVEMENT_LOCAL_VELOCITY_M_PER_S;
            }
            if (doorCurrentLocalPosition.z !== doorMovements.targetPosition.z) {
                doorMovements.zVelocity = (doorCurrentLocalPosition.z > doorMovements.targetPosition.z) ? 
                    -MOVEMENT_LOCAL_VELOCITY_M_PER_S : MOVEMENT_LOCAL_VELOCITY_M_PER_S;
            }
        },

        /* Move entities and if they are all in place, end the transition */
        updateEntities: function( doorMovements, shadeTargetHeight) {
            var doorCurrentLocalPosition = Entities.getEntityProperties(door, 'localPosition').localPosition;

            _this.maybeMoveDoorOnXAxis(doorMovements, doorCurrentLocalPosition);
            _this.maybeMoveDoorOnZAxis(doorMovements, doorCurrentLocalPosition);
            _this.maybeChangeShadeHeight(shadeTargetHeight);

            if (!doorMovements.xVelocity && !doorMovements.zVelocity && shadeHeightChange === 0) {
                _this.playSound(DONE_SOUND, DONE_VOLUME, buttonPosition, false, false);
                currentState = (currentState === "toClosed") ? "closed" : "open";
                Entities.editEntity(button, {
                    color: currentState === "closed" ? BUTTON_CLOSED_COLOR : BUTTON_OPEN_COLOR
                });
                if (updateInterval) {
                    Script.clearInterval(updateInterval);
                    updateInterval = null;
                }
            }
        },

        /* If the door is moving, check its position along the x axis to see if it is place. If it is, check if we need 
        to move it along the z axis and begin that movement if needed. */
        maybeMoveDoorOnXAxis: function(doorMovements, doorCurrentLocalPosition) {
            // If door is moving on x axis
            if (doorMovements.xVelocity && doorMovements.currentAxis === "x") {
                // If door is in place, stop x movement,delete the x movement from the JSON and begin z movement if necessary
                if (doorMovements.xVelocity > 0 && doorCurrentLocalPosition.x >= doorMovements.targetPosition.x || 
                        doorMovements.xVelocity < 0 && doorCurrentLocalPosition.x <= doorMovements.targetPosition.x) {
                    doorCurrentLocalPosition = {
                        x: doorMovements.targetPosition.x,
                        y: doorMovements.targetPosition.y,
                        z: doorCurrentLocalPosition.z
                    };
                    delete doorMovements.xVelocity;
                    if (doorMovements.zVelocity) {
                        doorMovements.currentAxis = "z";
                        Entities.editEntity(door, {
                            localVelocity:  { x: 0, y: 0, z: doorMovements.zVelocity },
                            localPosition: doorCurrentLocalPosition
                        });
                    } else {
                        Entities.editEntity(door, {
                            localVelocity: { x: 0, y: 0, z: 0 },
                            localPosition: doorMovements.targetPosition
                        });
                    }
                } 
            }
        },

        /* If the door is moving, check its position along the z axis to see if it is place. If it is, check if we need 
        to move it along the x axis and begin that movement if needed. */
        maybeMoveDoorOnZAxis: function(doorMovements, doorCurrentLocalPosition) {
            // If door is moving on z axis
            if (doorMovements.zVelocity && doorMovements.currentAxis === "z") {
                // If door is in place, stop z movement, delete the z movement from the JSON and begin x movement if necessary
                if (doorMovements.zVelocity > 0 && doorCurrentLocalPosition.z >= doorMovements.targetPosition.z || 
                        doorMovements.zVelocity < 0 && doorCurrentLocalPosition.z <= doorMovements.targetPosition.z) {
                    doorCurrentLocalPosition = {
                        x: doorCurrentLocalPosition.x,
                        y: doorMovements.targetPosition.y,
                        z: doorMovements.targetPosition.z
                    };
                    delete doorMovements.zVelocity;
                    if (doorMovements.xVelocity) {
                        doorMovements.currentAxis = "x";
                        Entities.editEntity(door, {
                            localVelocity:  { x: doorMovements.xVelocity, y: 0, z: 0 },
                            localPosition: doorCurrentLocalPosition
                        });
                    } else {
                        Entities.editEntity(door, {
                            localVelocity: { x: 0, y: 0, z: 0 },
                            localPosition: doorMovements.targetPosition
                        });
                    }
                } 
            }
        },

        /* Check if the shade is the correct height and adjust if not. */
        maybeChangeShadeHeight: function(shadeTargetHeight) {
            var shadeCurrentDimensions = Entities.getEntityProperties(shade, 'dimensions').dimensions;
            // If shade must be edited
            if (shadeHeightChange !== 0) {
                // If shade is in place
                if ((shadeHeightChange > 0 && (shadeCurrentDimensions.y >= (shadeTargetHeight - SHADE_TARGET_DEVIATION_ALLOWANCE))) || 
                    (shadeHeightChange < 0 && (shadeCurrentDimensions.y <= (shadeTargetHeight + SHADE_TARGET_DEVIATION_ALLOWANCE)))) {
                    shadeHeightChange = 0;
                    // do not snap shade as it makes the animation jittery. The height does no t need to be exact
                    Entities.editEntity(shade, {
                        visible: currentState === "toClosed"
                    });
                } else {
                    shadeCurrentDimensions.y += shadeHeightChange;
                    Entities.editEntity(shade, {
                        dimensions: shadeCurrentDimensions
                    });
                }
            }
        },

        /* Clear all intervals, stop injector, and place enties in 'open' position */
        unload: function() {
            Entities.editEntity(shade, {
                dimensions: DEFAULT_SHADE_RAISED_DIMENSIONS,
                visible: 0
            });
            Entities.editEntity(door, {
                localPosition: DEFAULT_DOOR_OPEN_LOCAL_POSITION,
                velocity: { x: 0, y: 0, z: 0 }
            });
            Entities.editEntity(button, {
                color: BUTTON_OPEN_COLOR
            });
            if (preloadDataRetrievalInterval) {
                Script.clearInterval(preloadDataRetrievalInterval);
                preloadDataRetrievalInterval = null;
            }
            if (updateInterval) {
                Script.clearInterval(updateInterval);
                updateInterval = null;
            }
            if (injector) {
                injector.stop();
            }
        }
    };

    return new PrivacyButton();
});
