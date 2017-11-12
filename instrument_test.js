function traceMethod(targetClassMethod) {
    var delim = targetClassMethod.lastIndexOf(".");
    if (delim === -1) return;

    var targetClass = targetClassMethod.slice(0, delim);
    var targetMethod = targetClassMethod.slice(delim + 1, targetClassMethod.length);

    var hook;
    try {
        hook = Java.use(targetClass);
    } catch (err) {
        return;
    }

    if (typeof hook[targetMethod] == 'undefined') {
        return;
    }

    var overloadCount = hook[targetMethod].overloads.length;

    console.log("[*] Tracing java method " + targetClassMethod + " [" + overloadCount + " overload(s)]");

    for (var i = 0; i < overloadCount; i++) {
        hook[targetMethod].overloads[i].implementation = function() {
            var retval = this[targetMethod].apply(this, arguments);

            var args = arguments;
            Java.perform(function() {
                if (typeof args[0] != 'undefined') {
                    var hookMsg = {
                        "function": targetClassMethod,
                        "struct": {}
                    };

                    hookMsg["struct"]["args"] = [];
                    for (var j = 0; j < args.length; j++) {
                        try {
                            hookMsg["struct"]["args"].push(JSON.parse(args[j]));
                        } catch (err) {}
                    }

                    var uri = Java.use("android.net.Uri");
                    var pt = ptr(args[0]["$handle"]);
                    var uriCls = Java.cast(pt, uri);

                    hookMsg["uri"] = uriCls.toString();

                    if (args[1] && typeof args[1] != 'undefined') {
                        var arrayUtils = Java.use("java.util.Arrays");
                        var strArray = Java.use("[Ljava.lang.String;");
                        pt = ptr(args[1]["$handle"]);
                        var projections = Java.cast(pt, strArray);
                        hookMsg["projection"] = arrayUtils.toString(projections);
                    } else {
                        hookMsg["projection"] = "None";
                    }

                    hookMsg["struct"]["backtrace"] = Java.use("android.util.Log")
                        .getStackTraceString(Java.use("java.lang.Exception").$new());
                    send(hookMsg);
                }
            });
            return retval;
        }
    }
}

function traceClassCtor(className, configs) {
    var hook = Java.use(className);
    var overloadCount = hook["$init"].overloads.length;

    console.log("[*] Tracing java CTor " + className + " [" + overloadCount + " overload(s)]");

    for (var i = 0; i < overloadCount; i++) {
        hook["$init"].overloads[i].implementation = function() {
            var retval = this["$init"].apply(this, arguments);

            var args = arguments;
            Java.perform(function() {
                var hookMsg = {
                    "function": className,
                    "struct": {}
                };

                hookMsg["struct"]["args"] = [];
                for (var j = 0; j < args.length; j++) {
                    if (configs["stringsOnly"] && typeof args[j] == 'string' || args[j] instanceof String)
                        hookMsg["struct"]["args"].push(args[j]);
                    else if (configs["stringsOnly"])
                        hookMsg["struct"]["args"].push(args[j]);
                }

                if (configs["backtrace"]) {
                    hookMsg["struct"]["backtrace"] = Java.use("android.util.Log")
                        .getStackTraceString(Java.use("java.lang.Exception").$new());
                }
                send(hookMsg);
            });

            return retval;
        }
    }
}

function traceModule(impl, name) {
    console.log("Tracing " + name);

    Interceptor.attach(impl, {
        onEnter: function(args) {
            // debug only the intended calls
            this.flag = true;

            if (this.flag) {
                console.warn("\n*** entered " + name);
                // print backtrace
                console.log("\nBacktrace:\n" + Thread.backtrace(this.context, Backtracer.ACCURATE)
                    .map(DebugSymbol.fromAddress).join("\n"));
            }
        },

        onLeave: function(retval) {
            if (this.flag) {
                // print retval
                console.log("\nretval: " + retval);
                console.warn("\n*** exiting " + name);
            }
        }
    });
}


function traceNativeFunct(exp, funct, onEnterCb, onLeaveCb) {
    console.log("[*] Tracing native funct " + funct + " in " + exp);

    Interceptor.attach(Module.findExportByName(exp, funct), {
        onEnter: function (args) {
            onEnterCb(args);
        },
        onLeave: function (retval) {
            onLeaveCb(retval);
        }
    });
}

function uniqBy(array, key) {
    var seen = {};
    return array.filter(function(item) {
        var k = key(item);
        return seen.hasOwnProperty(k) ? false : (seen[k] = true);
    });
}

function ba2hex(bufArray) {
    var uint8arr = new Uint8Array(bufArray);
    if (!uint8arr) {
        return '';
    }

    var hexStr = '';
    for (var i = 0; i < uint8arr.length; i++) {
        var hex = (uint8arr[i] & 0xff).toString(16);
        hex = (hex.length === 1) ? '0' + hex : hex;
        hexStr += hex;
    }

    return hexStr.toUpperCase();
}

function hex2a(hexx) {
    var hex = hexx.toString();
    var str = '';
    for (var i = 0; i < hex.length; i += 2)
        str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
    return str;
}

function initializeGlobals() {
    addresses = {};
    var resolver = new ApiResolver("module");
    var exps = [
        ["*libssl*",
            ["SSL_read", "SSL_write", "SSL_get_fd", "SSL_get_session",
                "SSL_SESSION_get_id"]],
        [Process.platform == "darwin" ? "*libsystem*" : "*libc*",
            ["getpeername", "getsockname", "ntohs", "ntohl"]]
    ];
    for (var i = 0; i < exps.length; i++) {
        var lib = exps[i][0];
        var names = exps[i][1];
        for (var j = 0; j < names.length; j++) {
            var name = names[j];
            var matches = resolver.enumerateMatchesSync("exports:" + lib + "!" +
                name);
            if (matches.length == 0) {
                throw "Could not find " + lib + "!" + name;
            } else if (matches.length != 1) {
                // Sometimes Frida returns duplicates.
                var address = 0;
                var s = "";
                var duplicates_only = true;
                for (var k = 0; k < matches.length; k++) {
                    if (s.length != 0) {
                        s += ", ";
                    }
                    s += matches[k].name + "@" + matches[k].address;
                    if (address == 0) {
                        address = matches[k].address;
                    }
                    else if (!address.equals(matches[k].address)) {
                        duplicates_only = false;
                    }
                }
                if (!duplicates_only) {
                    throw "More than one match found for " + lib + "!" + name + ": " +
                    s;
                }
            }
            addresses[name] = matches[0].address;
        }
    }

    SSL_get_fd = new NativeFunction(addresses["SSL_get_fd"], "int",
        ["pointer"]);
    SSL_get_session = new NativeFunction(addresses["SSL_get_session"],
        "pointer", ["pointer"]);
    SSL_SESSION_get_id = new NativeFunction(addresses["SSL_SESSION_get_id"],
        "pointer", ["pointer", "pointer"]);
    getpeername = new NativeFunction(addresses["getpeername"], "int", ["int",
        "pointer", "pointer"]);
    getsockname = new NativeFunction(addresses["getsockname"], "int", ["int",
        "pointer", "pointer"]);
    ntohs = new NativeFunction(addresses["ntohs"], "uint16", ["uint16"]);
    ntohl = new NativeFunction(addresses["ntohl"], "uint32", ["uint32"]);
}

function getPortsAndAddresses(sockfd, isRead) {
    var message = {};
    var addrlen = Memory.alloc(4);
    var addr = Memory.alloc(16);
    var src_dst = ["src", "dst"];
    for (var i = 0; i < src_dst.length; i++) {
        Memory.writeU32(addrlen, 16);
        if ((src_dst[i] == "src") ^ isRead) {
            getsockname(sockfd, addr, addrlen);
        } else {
            getpeername(sockfd, addr, addrlen);
        }
        message[src_dst[i] + "_port"] = ntohs(Memory.readU16(addr.add(2)));
        message[src_dst[i] + "_addr"] = ntohl(Memory.readU32(addr.add(4)));
    }
    return message;
}

function getSslSessionId(ssl) {
    var session = SSL_get_session(ssl);
    if (session == 0) {
        return 0;
    }
    var len = Memory.alloc(4);
    var p = SSL_SESSION_get_id(session, len);
    len = Memory.readU32(len);
    var session_id = "";
    for (var i = 0; i < len; i++) {
        session_id +=
            ("0" + Memory.readU8(p.add(i)).toString(16).toUpperCase()).substr(-2);
    }
    return session_id;
}

function inject() {
    Java.perform(function () {
        traceMethod("android.content.ContentResolver.query");
    });
}

function exist(src, val) {
    return src.toLowerCase().indexOf(val) != -1;
}

setTimeout(function () {
    initializeGlobals();
    inject();
}, 0);
