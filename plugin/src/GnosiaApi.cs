// GNOSIA API — BepInEx plugin, v0.1 (inspector build)
//
// Purpose of this first build: prove the plumbing and dump the REAL shape of the
// game state, so the /state schema can be designed against observed data instead
// of guessed field types. Everything is read by reflection, so a wrong field name
// returns null instead of failing to compile.
//
// Threading model (same as LLM_API): HttpListener lives on a background thread;
// any work that touches Unity objects is queued and run by Update() on the main
// thread, with the HTTP thread blocking on a ManualResetEventSlim.

using BepInEx;
using BepInEx.Configuration;
using BepInEx.Logging;
using HarmonyLib;
using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Net;
using System.Reflection;
using System.Text;
using System.Threading;
using UnityEngine;

namespace GnosiaApi
{
    internal sealed class Command
    {
        public Func<string> Work;
        public string Result;
        public string Error;
        public readonly ManualResetEventSlim Done = new ManualResetEventSlim(false);

        public void Complete(string result)
        {
            Result = result;
            Done.Set();
        }

        public void Fail(Exception error)
        {
            Error = error == null ? "unknown error" : error.GetType().Name + ": " + error.Message;
            Done.Set();
        }
    }

    [BepInPlugin(Guid, "GNOSIA API", Version)]
    public class GnosiaApiPlugin : BaseUnityPlugin
    {
        public const string Guid = "local.gnosia.api";
        public const string Version = "0.1.0";

        internal static ManualLogSource Log;
        internal static readonly ConcurrentQueue<Command> Commands = new ConcurrentQueue<Command>();

        private static ConfigEntry<int> _portEntry;
        private const int DefaultPort = 48711;
        private static int _port = DefaultPort;
        private static HttpListener _listener;
        private static Thread _thread;
        private static int _served;
        private static int _queueDrained;

        private void Awake()
        {
            Log = Logger;
            // GNOSIA ships with Run In Background off, so Unity stops the whole
            // player loop (including our Update pump) the moment the window loses
            // focus. Without this every request would hang while the user is
            // typing in another window.
            Application.runInBackground = true;

            _portEntry = Config.Bind("server", "port", DefaultPort, "Loopback port for the HTTP API (127.0.0.1 only).");
            _port = _portEntry.Value;
            Log.LogInfo("GNOSIA API " + Version + " loaded (BepInEx plugin guid " + Guid + ")");
            try
            {
                Probe.InitHarmony(Guid + ".hook");
                Probe.InstallHooks();
                Log.LogInfo(Probe._doScriptPatched
                    ? "DoScript hook installed (advance without keyboard)"
                    : "WARNING: DoScript hook NOT installed; /action/advance will be a no-op");
                Log.LogInfo("input hooks: button=" + Probe._inputPatched + " click=" + Probe._clickPatched);
            }
            catch (Exception error)
            {
                Log.LogError("harmony setup failed: " + error);
            }
            try
            {
                StartServer();
            }
            catch (Exception error)
            {
                Log.LogError("HTTP server failed to start: " + error);
            }
        }

        private void Update()
        {
            // The game may reset this on scene changes; re-assert it cheaply so the
            // pump keeps running while the window is in the background.
            if (!Application.runInBackground)
            {
                Application.runInBackground = true;
            }

            // Drain a bounded number of commands per frame: a slow request must
            // never stall the game's own Update.
            for (int i = 0; i < 16; i++)
            {
                Command command;
                if (!Commands.TryDequeue(out command))
                {
                    break;
                }
                _queueDrained++;
                try
                {
                    command.Complete(command.Work());
                }
                catch (Exception error)
                {
                    command.Fail(Unwrap(error));
                }
            }
        }

        private void OnDestroy()
        {
            StopServer();
        }

        private static Exception Unwrap(Exception error)
        {
            TargetInvocationException wrapped = error as TargetInvocationException;
            return wrapped != null && wrapped.InnerException != null ? wrapped.InnerException : error;
        }

        // ---------------------------------------------------------------- server

        private static void StartServer()
        {
            _listener = new HttpListener();
            _listener.Prefixes.Add("http://127.0.0.1:" + _port + "/");
            _listener.Start();
            _thread = new Thread(Loop);
            _thread.IsBackground = true;
            _thread.Name = "gnosia-api";
            _thread.Start();
            Log.LogInfo("listening on http://127.0.0.1:" + _port + "/");
        }

        private static void StopServer()
        {
            try
            {
                if (_listener != null)
                {
                    _listener.Stop();
                    _listener.Close();
                }
            }
            catch
            {
                // shutting down anyway
            }
            _listener = null;
        }

        private static void Loop()
        {
            while (true)
            {
                HttpListenerContext context;
                try
                {
                    context = _listener.GetContext();
                }
                catch
                {
                    return;
                }

                try
                {
                    Route(context);
                }
                catch (Exception error)
                {
                    Respond(context, 500, "{\"ok\":false,\"error\":" + Json.Quote(error.Message) + "}");
                }
            }
        }

        private static void Route(HttpListenerContext context)
        {
            string path = context.Request.Url == null ? "/" : context.Request.Url.AbsolutePath;
            // string.TrimEnd(char) does not exist on Mono's mscorlib (it is a
            // netstandard 2.1 overload), so trim the old way.
            while (path.Length > 1 && path.EndsWith("/", StringComparison.Ordinal))
            {
                path = path.Substring(0, path.Length - 1);
            }
            if (path.Length == 0)
            {
                path = "/";
            }

            if (path == "/ping")
            {
                Respond(context, 200, "{\"ok\":true,\"version\":" + Json.Quote(Version)
                    + ",\"served\":" + _served + ",\"queue_drained\":" + _queueDrained + "}");
                return;
            }

            if (path == "/state")
            {
                bool raw = context.Request.QueryString["raw"] == "1";
                Respond(context, 200, OnGameThread(delegate { return Probe.State(raw); }));
                return;
            }

            if (path == "/field")
            {
                string type = context.Request.QueryString["type"];
                string field = context.Request.QueryString["field"];
                Respond(context, 200, OnGameThread(delegate { return Probe.Field(type, field); }));
                return;
            }

            if (path == "/dump")
            {
                string typeName = context.Request.QueryString["type"];
                if (string.IsNullOrEmpty(typeName))
                {
                    typeName = "gnosia.GameData";
                }
                string limitText = context.Request.QueryString["limit"];
                int limit = 200;
                if (!string.IsNullOrEmpty(limitText))
                {
                    int.TryParse(limitText, out limit);
                }
                string captured = typeName;
                int capturedLimit = limit;
                bool findInstance = context.Request.QueryString["find"] == "1";
                bool wantMethods = context.Request.QueryString["methods"] == "1";
                Respond(context, 200, OnGameThread(delegate
                {
                    return wantMethods ? Probe.Methods(captured) : Probe.Dump(captured, capturedLimit, findInstance);
                }));
                return;
            }

            if (path == "/action/move")
            {
                string placeText = context.Request.QueryString["place"];
                int place;
                if (string.IsNullOrEmpty(placeText) || !int.TryParse(placeText, out place))
                {
                    Respond(context, 400, "{\"ok\":false,\"error\":\"place is required, e.g. /action/move?place=6\"}");
                    return;
                }
                Respond(context, 200, OnGameThread(delegate { return Probe.Move(place); }));
                return;
            }

            if (path == "/action/advance")
            {
                Respond(context, 200, OnGameThread(Probe.Advance));
                return;
            }

            if (path == "/action/click" || path == "/action/call")
            {
                string screen = context.Request.QueryString["screen"] ?? "InterfaceScreen";
                string method = context.Request.QueryString["method"] ?? "";
                int index = 0;
                int.TryParse(context.Request.QueryString["index"] ?? "0", out index);
                if (method.Length == 0)
                {
                    Respond(context, 400, "{\"ok\":false,\"error\":\"method is required, e.g. /action/click?screen=InterfaceScreen&method=EnterComandButton&index=2\"}");
                    return;
                }
                // /action/call just invokes the method; /action/click also answers
                // the handler's Input.GetMouseButtonDown check, which is what makes
                // the screen treat it as a real press.
                bool armClick = path == "/action/click" || context.Request.QueryString["click"] == "1";
                string capturedScreen = screen;
                string capturedMethod = method;
                int capturedIndex = index;
                bool capturedArm = armClick;
                Respond(context, 200, OnGameThread(delegate
                {
                    return Probe.Click(capturedScreen, capturedMethod, capturedIndex, capturedArm);
                }));
                return;
            }

            // Invoke a method that takes no arguments, or one string argument.
            // The mouse-click route only supports (int), which locks out screens
            // whose confirmation is an argument-less handler (EnterSelect), and
            // fields whose setter takes the text (InputFieldDeselect).
            // Where the game actually keeps its files. GNOSIA does not show up
            // under AppData\LocalLow\<Company>\<Product>, so the only reliable way
            // to find the save folder is to ask Unity at runtime.
            // Character-creation stat points.
            //
            // Adding points through the controller is not usable from here: the
            // screen reads IsMenuLeftRight every frame, so one injected press can
            // land several +1s or drift the cursor between the value and the "+1"
            // slot. Writing the array the screen edits (baseData.takashiAbil) and
            // zeroing the remaining counter is deterministic.
            if (path == "/action/setabil")
            {
                string values = context.Request.QueryString["values"];
                string left = context.Request.QueryString["left"];
                Respond(context, 200, OnGameThread(delegate { return Probe.SetAbil(values, left); }));
                return;
            }

            // Read an arbitrary dotted path, with numbers indexing into lists and
            // arrays: "chara.3.yaku", "baseData.takashiAbil.0". The dump route only
            // reaches one level, which made everything inside GameData+character
            // invisible - and that is exactly where per-character role/claim data
            // lives.
            if (path == "/action/path")
            {
                string type = context.Request.QueryString["type"] ?? "gnosia.GameData";
                string expr = context.Request.QueryString["path"] ?? "";
                Respond(context, 200, OnGameThread(delegate { return Probe.ReadPath(type, expr); }));
                return;
            }

            // Field names of a type, so new data does not need a decompile trip.
            if (path == "/action/fields")
            {
                string type = context.Request.QueryString["type"] ?? "gnosia.GameData";
                Respond(context, 200, OnGameThread(delegate { return Probe.Fields(type); }));
                return;
            }

            if (path == "/action/abil")
            {
                Respond(context, 200, OnGameThread(delegate { return Probe.ReadAbil(); }));
                return;
            }

            if (path == "/env")
            {
                Respond(context, 200, OnGameThread(delegate { return Probe.Env(); }));
                return;
            }

            // Write a text input directly instead of typing into it.
            //
            // The name-entry screen is a Unity input box: driving it through the
            // controller means focusing the field and sending keys, which steals
            // window focus. Writing the InputField's text property goes through
            // the component's own setter, so onValueChanged fires exactly like a
            // paste would - without touching the OS input queue.
            if (path == "/action/setinput")
            {
                string screen = context.Request.QueryString["screen"] ?? "";
                string text = context.Request.QueryString["text"];
                if (screen.Length == 0)
                {
                    Respond(context, 400, "{\"ok\":false,\"error\":\"screen is required, e.g. /action/setinput?screen=TakashiSetScreen&text=孤魂野鬼\"}");
                    return;
                }
                string capturedScreen = screen;
                string capturedText = text;
                Respond(context, 200, OnGameThread(delegate
                {
                    return Probe.SetInput(capturedScreen, capturedText);
                }));
                return;
            }

            if (path == "/action/call0")
            {
                string screen = context.Request.QueryString["screen"] ?? "";
                string method = context.Request.QueryString["method"] ?? "";
                string arg = context.Request.QueryString["arg"];
                if (screen.Length == 0 || method.Length == 0)
                {
                    Respond(context, 400, "{\"ok\":false,\"error\":\"screen and method are required\"}");
                    return;
                }
                string capturedScreen = screen;
                string capturedMethod = method;
                string capturedArg = arg;
                Respond(context, 200, OnGameThread(delegate
                {
                    return Probe.CallNoArg(capturedScreen, capturedMethod, capturedArg);
                }));
                return;
            }

            // Write the 初期条件設定 numbers directly.
            //
            // That screen is a mouse/controller form: its own click handler only
            // ever adds one to a role (or subtracts one from 人数), so a target
            // like "12人 / 4古诺希亚 / 留舰者为0" cannot be reached by clicking -
            // some values can only go up, others only down. Writing the fields and
            // then running the screen's own CountMura/SetButtons keeps the display
            // and the derived 乘客 count consistent.
            if (path == "/action/setup")
            {
                string peopleRaw = context.Request.QueryString["people"];
                string gnosiaRaw = context.Request.QueryString["gnosia"];
                string rolesRaw = context.Request.QueryString["roles"];
                string selfRaw = context.Request.QueryString["self"];
                Respond(context, 200, OnGameThread(delegate
                {
                    return Probe.Setup(peopleRaw, gnosiaRaw, rolesRaw, selfRaw);
                }));
                return;
            }

            if (path == "/action/set")
            {
                string screen = context.Request.QueryString["screen"] ?? "InterfaceScreen";
                string field = context.Request.QueryString["field"] ?? "";                string raw = context.Request.QueryString["value"];
                if (field.Length == 0)
                {
                    Respond(context, 400, "{\"ok\":false,\"error\":\"field is required\"}");
                    return;
                }
                string capturedScreen = screen;
                string capturedField = field;
                string capturedRaw = raw;
                Respond(context, 200, OnGameThread(delegate
                {
                    return Probe.SetField(capturedScreen, capturedField, capturedRaw);
                }));
                return;
            }

            if (path == "/action/target")
            {
                int index = 0;
                int.TryParse(context.Request.QueryString["index"] ?? "0", out index);
                bool confirm = context.Request.QueryString["confirm"] == "1";
                int capturedIndex = index;
                bool capturedConfirm = confirm;
                Respond(context, 200, OnGameThread(delegate
                {
                    return Probe.Target(capturedIndex, capturedConfirm);
                }));
                return;
            }

            if (path == "/action/targets")
            {
                Respond(context, 200, OnGameThread(delegate { return Probe.TargetList(); }));
                return;
            }

            if (path == "/action/vote")
            {
                // No index means "confirm only": keep the cursor where the player
                // left it instead of silently jumping back to row 0.
                int index = -1;
                bool hasIndex = int.TryParse(context.Request.QueryString["index"] ?? "", out index);
                if (!hasIndex)
                {
                    index = -1;
                }
                bool confirmVote = context.Request.QueryString["confirm"] == "1";
                int capturedIndex = index;
                bool capturedConfirm = confirmVote;
                Respond(context, 200, OnGameThread(delegate { return Probe.Vote(capturedIndex, capturedConfirm); }));
                return;
            }

            if (path == "/action/close")
            {
                Respond(context, 200, OnGameThread(Probe.Close));
                return;
            }

            if (path == "/action/press")
            {
                int action = 0;
                int.TryParse(context.Request.QueryString["action"] ?? "0", out action);
                int millis = 90;
                int.TryParse(context.Request.QueryString["ms"] ?? "90", out millis);
                int capturedAction = action;
                int capturedMillis = millis;
                Respond(context, 200, OnGameThread(delegate { return Probe.Press(capturedAction, capturedMillis); }));
                return;
            }

            if (path == "/action/select")
            {
                int index;
                if (!int.TryParse(context.Request.QueryString["index"] ?? "", out index))
                {
                    Respond(context, 400, "{\"ok\":false,\"error\":\"index is required, e.g. /action/select?index=3\"}");
                    return;
                }
                int captured = index;
                Respond(context, 200, OnGameThread(delegate { return Probe.SelectCommand(captured); }));
                return;
            }

            if (path == "/action/command")
            {
                int index;
                if (!int.TryParse(context.Request.QueryString["index"] ?? "", out index))
                {
                    Respond(context, 400, "{\"ok\":false,\"error\":\"index is required, e.g. /action/command?index=3\"}");
                    return;
                }
                int captured = index;
                Respond(context, 200, OnGameThread(delegate { return Probe.CommitCommand(captured); }));
                return;
            }

            if (path == "/areas")
            {
                Respond(context, 200, OnGameThread(delegate { return Probe.Areas(); }));
                return;
            }

            if (path == "/screens")
            {
                Respond(context, 200, OnGameThread(delegate { return Probe.Screens(); }));
                return;
            }

            // Every live TextArea, including the ones no screen registered in its
            // m_textAreaMap - that is where the tutorial body lives.
            if (path == "/textareas")
            {
                Respond(context, 200, OnGameThread(delegate { return Probe.AllTextAreas(); }));
                return;
            }

            if (path == "/tmptexts")
            {
                Respond(context, 200, OnGameThread(delegate { return Probe.AllTmpTexts(); }));
                return;
            }

            if (path == "/action/ui")
            {
                string screen = context.Request.QueryString["screen"] ?? "";
                if (screen.Length == 0)
                {
                    Respond(context, 400, "{\"ok\":false,\"error\":\"screen is required, e.g. /action/ui?screen=TitleScreen&index=1&confirm=1\"}");
                    return;
                }
                int index = 0;
                int.TryParse(context.Request.QueryString["index"] ?? "0", out index);
                bool confirm = context.Request.QueryString["confirm"] == "1";
                bool navigate = context.Request.QueryString["nav"] != "0";
                string capturedScreen = screen;
                int capturedIndex = index;
                Respond(context, 200, OnGameThread(delegate
                {
                    return Probe.Ui(capturedScreen, capturedIndex, confirm, navigate);
                }));
                return;
            }

            Respond(context, 404, "{\"ok\":false,\"error\":\"unknown route\",\"routes\":[\"/ping\",\"/state\",\"/dump?type=gnosia.GameData\",\"/field?type=&field=\",\"/action/move?place=\",\"/action/ui?screen=&index=&confirm=\"]}");
        }

        private static void Respond(HttpListenerContext context, int status, string body)
        {
            try
            {
                byte[] bytes = Encoding.UTF8.GetBytes(body);
                context.Response.StatusCode = status;
                context.Response.ContentType = "application/json; charset=utf-8";
                context.Response.ContentLength64 = bytes.Length;
                context.Response.OutputStream.Write(bytes, 0, bytes.Length);
                context.Response.OutputStream.Close();
                _served++;
            }
            catch
            {
                // client disappeared
            }
        }

        internal static string OnGameThread(Func<string> work)
        {
            Command command = new Command();
            command.Work = work;
            Commands.Enqueue(command);
            if (!command.Done.Wait(5000))
            {
                throw new Exception("the game loop did not answer within 5000ms. Either the game window is paused in the background (Run In Background is off), or it is stuck on a loading screen. Focus the game and retry.");
            }
            if (command.Error != null)
            {
                throw new Exception(command.Error);
            }
            return command.Result;
        }
    }

    // ------------------------------------------------------------ reflection

    internal static class Reflect
    {
        private static readonly Dictionary<string, Type> Cache = new Dictionary<string, Type>();

        public static Type Find(string fullName)
        {
            if (string.IsNullOrEmpty(fullName))
            {
                return null;
            }
            Type cached;
            if (Cache.TryGetValue(fullName, out cached))
            {
                return cached;
            }
            Type found = null;
            Assembly[] assemblies = AppDomain.CurrentDomain.GetAssemblies();
            for (int i = 0; i < assemblies.Length; i++)
            {
                try
                {
                    found = assemblies[i].GetType(fullName, false);
                }
                catch
                {
                    found = null;
                }
                if (found != null)
                {
                    break;
                }
            }
            if (found != null)
            {
                // Never cache a miss: the first call can land before the game
                // assembly is fully loaded.
                Cache[fullName] = found;
            }
            return found;        }

        public static object Static(Type type, string field)
        {
            if (type == null)
            {
                return null;
            }
            FieldInfo info = type.GetField(field, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
            return info == null ? null : info.GetValue(null);
        }

        public static object Get(object target, string field)
        {
            if (target == null)
            {
                return null;
            }
            FieldInfo info = target.GetType().GetField(field, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            return info == null ? null : info.GetValue(target);
        }

        public static bool Set(object target, string field, object value)
        {
            if (target == null)
            {
                return false;
            }
            FieldInfo info = target.GetType().GetField(field, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            if (info == null)
            {
                return false;
            }
            info.SetValue(target, value);
            return true;
        }

        public static object FirstInstance(string typeName)
        {
            Type type = Find(typeName);
            if (type == null)
            {
                return null;
            }
            UnityEngine.Object[] objects = Resources.FindObjectsOfTypeAll(type);
            if (objects == null || objects.Length == 0)
            {
                return null;
            }
            return objects[0];
        }

        // Instance method first, then static: the probe does not know in advance
        // which one the game used, and GetMethod(name, flags) would explode on
        // overloads anyway.
        public static object Call(object target, string method, params object[] args)
        {
            if (target == null)
            {
                return null;
            }
            int wanted = args == null ? 0 : args.Length;
            Type type = target.GetType();
            MethodInfo info = Match(type, method, wanted, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            object[] actual = args;
            if (info == null)
            {
                info = Match(type, method, wanted, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
                actual = args;
            }
            return info == null ? null : info.Invoke(info.IsStatic ? null : target, actual);
        }

        private static MethodInfo Match(Type type, string name, int parameterCount, BindingFlags flags)
        {
            MethodInfo[] methods = type.GetMethods(flags);
            for (int i = 0; i < methods.Length; i++)
            {
                if (methods[i].Name == name && methods[i].GetParameters().Length == parameterCount)
                {
                    return methods[i];
                }
            }
            return null;
        }

        public static string TypeName(object value)
        {
            if (value == null)
            {
                return "null";
            }
            Type asType = value as Type;
            if (asType != null)
            {
                return asType.FullName;
            }
            return value.GetType().FullName;
        }
    }

    // ---------------------------------------------------------------- probe

    internal static class Probe
    {
        // The day counter only exists on the discussion overlay; remember the last
        // value so menus that replace the overlay don't blank it out.
        private static int _lastDay = -1;
        // Stable schema. ?raw=1 appends the exploratory dump used while the field
        // types were still being discovered.
        public static string State(bool raw)
        {
            Json.Writer json = new Json.Writer();
            json.BeginObject();
            json.Key("ok").Bool(true);
            json.Key("version").Str(GnosiaApiPlugin.Version);

            Type dataType = Reflect.Find("gnosia.Data");
            object gd = Reflect.Static(dataType, "gd");
            json.Key("in_game").Bool(gd != null);
            if (gd == null)
            {
                json.Key("hint").Str("gnosia.Data.gd is null: start or resume a run first (title screen and loading have no live game)");
                json.EndObject();
                return json.ToString();
            }

            object yaku = Reflect.Get(gd, "shujinkoYaku");
            string roleName = yaku == null ? null : yaku.ToString();
            json.Key("role").Str(roleName);
            json.Key("role_cn").Str(ChineseRole(roleName));
            json.Key("role_enum").Str(Reflect.TypeName(yaku));

            IList nissi = Reflect.Get(gd, "nissiList") as IList;
            json.Key("nissi_actions").Num(nissi == null ? 0 : nissi.Count);
            if (nissi != null && nissi.Count > 0)
            {
                json.Key("nissi_last").Describe(nissi[nissi.Count - 1], 2);
            }

            // Screen text areas carry what the player actually sees. Several screens
            // coexist (discussion overlay + action list), so keys are looked up
            // across all of them.
            List<IDictionary> areas = TextAreaMaps();
            string dayText = AreaTextAny(areas, "day");
            int day = ParseDay(dayText);
            if (day > 0)
            {
                _lastDay = day;
            }
            json.Key("day").Num(day > 0 ? day : _lastDay);
            json.Key("day_text").Str(dayText);
            json.Key("speaker_badge").Str(AreaTextAny(areas, "mainname"));
            json.Key("role_badge").Str(AreaTextAny(areas, "role"));
            string commandText = AreaTextAny(areas, "command");
            json.Key("command").Str(commandText);
            json.Key("command_list").Raw(CommandList(areas));
            json.Key("command_selected").Str(AreaTextAny(areas, "com_Name"));
            json.Key("command_desc").Str(AreaTextAny(areas, "com_Desc"));
            json.Key("targets").Raw(TargetTexts(areas));
            // Generic escape hatch: every non-empty text area of every live screen,
            // keyed by its own name. Covers panels that are not modelled above
            // (参考数据, 投票结果, 乘客信息 ...) without hardcoding their keys.
            // Raw interface flags. The command list only becomes non-empty when the
            // player can act, so select_num0 doubles as a "my turn" hint.
            object iface = ActiveInstance("application.InterfaceScreen");
            if (iface != null)
            {
                json.Key("interface").BeginObject();
                json.Key("is_speak").Describe(Reflect.Get(iface, "isSpeak"), 0);
                json.Key("is_data").Describe(Reflect.Get(iface, "isData"), 0);
                json.Key("is_menu").Describe(Reflect.Get(iface, "isMenu"), 0);
                json.Key("is_wait").Describe(Reflect.Get(iface, "isWait"), 0);
                json.Key("select").Describe(Reflect.Get(iface, "select"), 0);
                // nowPhase is the honest "is the game waiting for a pick" flag:
                // 1 = the command column is up, 0 = a plain line of dialogue.
                // selectNum[0] and the command text are caches that survive the
                // window, so they cannot answer that question.
                json.Key("now_phase").Describe(Reflect.Get(iface, "nowPhase"), 0);
                object counts = Reflect.Get(iface, "selectNum");
                IList countList = counts as IList;
                json.Key("select_num0").Num(countList != null && countList.Count > 0 ? AsNumber(countList[0]) : -1);
                // Column 1 is the target list (怀疑/袒护/vote). MyUpdate builds it
                // by itself right after a command commits: select becomes 1 and
                // selectNum[1] gets the number of people. Exposing it lets callers
                // wait for the real thing instead of guessing a delay.
                json.Key("select_num1").Num(countList != null && countList.Count > 1 ? AsNumber(countList[1]) : -1);
                json.Key("select_num_list").BeginArray();
                if (countList != null)
                {
                    for (int ci = 0; ci < countList.Count; ci++)
                    {
                        json.Num(AsNumber(countList[ci]));
                    }
                }
                json.EndArray();
                RoundBlock(json, iface);
                // The four corner buttons (发言/参考数据/观察情况/菜单) are ordinary
                // sprites. Whether they are on screen says the game is waiting for
                // the player, which also covers the report rounds that draw no
                // ROUND counter at all.
                IDictionary btnMap = Reflect.Get(iface, "m_spriteMap") as IDictionary;
                json.Key("buttons").BeginObject();
                json.Key("speak").Bool(VisibleByKey(btnMap, 1000));
                json.Key("data").Bool(VisibleByKey(btnMap, 1100));
                json.Key("menu").Bool(VisibleByKey(btnMap, 1200));
                json.Key("wait").Bool(VisibleByKey(btnMap, 1300));
                json.EndObject();
                // The 发言 button is the real "you may speak now" signal, and the
                // command text is what that menu contains. Exposing both together
                // is what stops a caller from walking the story with Enter while
                // a speech menu was waiting to be opened with W - Enter there
                // means "take the highlighted row", i.e. it answers for the player.
                int selNow = (int)AsNumber(Reflect.Get(iface, "select"));
                json.Key("speak").BeginObject();
                json.Key("button_visible").Bool(VisibleByKey(btnMap, 1000));
                json.Key("menu_open").Bool(selNow >= 0);
                json.Key("options").BeginArray();
                if (selNow >= 0 && !string.IsNullOrEmpty(commandText))
                {
                    string[] rows = commandText.Split(new char[] { '\n' });
                    for (int ri = 0; ri < rows.Length; ri++)
                    {
                        string row = rows[ri] == null ? "" : rows[ri].Trim();
                        if (row.Length > 0)
                        {
                            json.Str(row);
                        }
                    }
                }
                json.EndArray();
                json.EndObject();
                ActionBlock(json, iface);
                json.EndObject();
            }

            json.Key("textareas").Raw(AllAreaTexts(areas));

            object moveScreen = Reflect.FirstInstance("application.Move2Screen");
            if (moveScreen != null)
            {
                json.Key("map").Raw(MapView(moveScreen));
            }

            Type logType = Reflect.Find("application.MessageLog");
            object names = Reflect.Static(logType, "mesLogName_now");
            object texts = Reflect.Static(logType, "mesLogText_now");
            json.Key("speaker").Str(FirstText(names));
            json.Key("text").Str(JoinText(texts));
            json.Key("text_lines").Describe(texts, 1);

            json.Key("choices").Raw(Choices(Reflect.Get(gd, "actions")));
            json.Key("crew").Raw(Crew(Reflect.Static(dataType, "Chara"), Reflect.Get(gd, "chara")));

            if (raw)
            {
                json.Key("raw").Raw(RawDump(gd, dataType));
            }

            json.EndObject();
            return json.ToString();
        }

        // GNOSIA shows several Screen instances at once (discussion overlay, action
        // list, data screens), each with its own m_textAreaMap and different keys.
        // Collect them all and look keys up across the set.
        private static List<IDictionary> TextAreaMaps()
        {
            List<IDictionary> maps = new List<IDictionary>();
            Type screenType = Reflect.Find("application.Screen");
            if (screenType == null)
            {
                return maps;
            }
            UnityEngine.Object[] screens = Resources.FindObjectsOfTypeAll(screenType);
            if (screens == null)
            {
                return maps;
            }
            for (int i = 0; i < screens.Length; i++)
            {
                IDictionary map = Reflect.Get(screens[i], "m_textAreaMap") as IDictionary;
                if (map != null && map.Count > 0)
                {
                    maps.Add(map);
                }
            }
            return maps;
        }

        private static string AreaTextAny(List<IDictionary> maps, string key)
        {
            for (int i = 0; i < maps.Count; i++)
            {
                string text = AreaText(maps[i], key);
                if (!string.IsNullOrEmpty(text))
                {
                    return text;
                }
            }
            return null;
        }

        private static string AreaText(IDictionary areas, string key)
        {
            if (areas == null || string.IsNullOrEmpty(key) || !areas.Contains(key))
            {
                return null;
            }
            object area = areas[key];
            if (area == null)
            {
                return null;
            }
            string text = JoinText(Reflect.Get(area, "strList"));
            if (string.IsNullOrEmpty(text))
            {
                text = JoinText(Reflect.Get(area, "strNowList"));
            }
            return text;
        }

        // Every TextArea that is alive right now, not only the ones a screen has
        // registered in its m_textAreaMap.
        //
        // The help/tutorial pages need this: 基本规则 / 界面说明 / ... draw their
        // body through an area that never shows up in the screen's map, so the map
        // view reports only the page title. Walking all live instances is the only
        // way to get a tutorial page as text instead of OCR-ing a screenshot.
        public static string AllTextAreas()
        {
            Json.Writer json = new Json.Writer();
            json.BeginObject();
            Type type = Reflect.Find("coreSystem.TextArea");
            json.Key("ok").Bool(type != null);
            int count = 0;
            json.Key("areas").BeginArray();
            if (type != null)
            {
                UnityEngine.Object[] objects = Resources.FindObjectsOfTypeAll(type);
                if (objects != null)
                {
                    for (int i = 0; i < objects.Length; i++)
                    {
                        object area = objects[i];
                        if (area == null)
                        {
                            continue;
                        }
                        string text = JoinText(Reflect.Get(area, "strList"));
                        if (string.IsNullOrEmpty(text))
                        {
                            text = JoinText(Reflect.Get(area, "strNowList"));
                        }
                        // Help pages bypass strList and write straight into the TMP
                        // component, so the area looks empty from the list fields.
                        if (string.IsNullOrEmpty(text))
                        {
                            text = Reflect.Get(Reflect.Get(area, "textBase"), "m_text") as string;
                        }
                        // Some layouts keep one TMP per line in textSpriteList
                        // instead of a single textBase.
                        if (string.IsNullOrEmpty(text))
                        {
                            text = JoinTmpList(Reflect.Get(area, "textSpriteList"));
                        }
                        if (string.IsNullOrEmpty(text))
                        {
                            continue;
                        }
                        object baseText = Reflect.Get(area, "textBase");
                        object visible = Reflect.Get(area, "visible");
                        json.BeginObject();
                        json.Key("index").Num(i);
                        json.Key("owner").Str(baseText == null ? "" : baseText.ToString());
                        json.Key("visible").Bool(visible is bool && (bool)visible);
                        json.Key("text").Str(text);
                        json.EndObject();
                        count++;
                    }
                }
            }
            json.EndArray();
            json.Key("count").Num(count);
            json.EndObject();
            return json.ToString();
        }

        // Every piece of text a TMP component is currently showing.
        //
        // The help screen's page body is not in strList and not in any screen's
        // m_textAreaMap - it sits directly in the TextMeshProUGUI's m_text. Walking
        // all TMP instances is the only view that sees it, and it also doubles as a
        // general "what does the screen say" dump for any UI the game invents.
        public static string AllTmpTexts()
        {
            Json.Writer json = new Json.Writer();
            json.BeginObject();
            Type type = Reflect.Find("TMPro.TextMeshProUGUI");
            json.Key("ok").Bool(type != null);
            int count = 0;
            json.Key("texts").BeginArray();
            if (type != null)
            {
                UnityEngine.Object[] objects = Resources.FindObjectsOfTypeAll(type);
                if (objects != null)
                {
                    for (int i = 0; i < objects.Length; i++)
                    {
                        object tmp = objects[i];
                        if (tmp == null)
                        {
                            continue;
                        }
                        string text = Reflect.Get(tmp, "m_text") as string;
                        if (string.IsNullOrEmpty(text) || text.Length < 2)
                        {
                            continue;
                        }
                        json.BeginObject();
                        json.Key("index").Num(i);
                        json.Key("owner").Str(tmp.ToString());
                        json.Key("text").Str(text);
                        json.EndObject();
                        count++;
                    }
                }
            }
            json.EndArray();
            json.Key("count").Num(count);
            json.EndObject();
            return json.ToString();
        }

        // "第2天" -> 2. Returns -1 when the counter is not on screen.
        private static int ParseDay(string text)
        {
            if (string.IsNullOrEmpty(text))
            {
                return -1;
            }
            int start = text.IndexOf("第");
            if (start < 0)
            {
                return -1;
            }
            int end = text.IndexOf("天", start + 1);
            if (end < 0)
            {
                return -1;
            }
            string digits = text.Substring(start + 1, end - start - 1).Trim();
            int value;
            return int.TryParse(digits, out value) ? value : -1;
        }

        // Every non-empty text area of every live screen, keyed by its own name.
        private static string AllAreaTexts(List<IDictionary> areas)
        {
            Json.Writer json = new Json.Writer();
            json.BeginObject();
            List<string> seen = new List<string>();
            int emitted = 0;
            for (int i = 0; i < areas.Count && emitted < 40; i++)
            {
                IDictionary map = areas[i];
                foreach (DictionaryEntry entry in map)
                {
                    if (emitted >= 40)
                    {
                        break;
                    }
                    string key = entry.Key == null ? null : entry.Key.ToString();
                    if (string.IsNullOrEmpty(key) || seen.Contains(key))
                    {
                        continue;
                    }
                    string text = AreaText(map, key);
                    if (string.IsNullOrEmpty(text))
                    {
                        continue;
                    }
                    seen.Add(key);
                    json.Key(key).Str(text);
                    emitted++;
                }
            }
            json.EndObject();
            return json.ToString();
        }

        private static string TargetTexts(List<IDictionary> areas)
        {            Json.Writer json = new Json.Writer();
            json.BeginObject();
            string[] keys = new string[] { "tgt_ll", "tgt_lr", "tgt_s" };
            for (int i = 0; i < keys.Length; i++)
            {
                json.Key(keys[i]).Str(AreaTextAny(areas, keys[i]));
            }
            json.EndObject();
            return json.ToString();
        }

        // The action list ("指令一览") renders its two columns into com_L / com_R,
        // one command per line, with com_Name / com_Desc describing the cursor.
        private static string CommandList(List<IDictionary> areas)
        {
            Json.Writer json = new Json.Writer();
            json.BeginObject();
            json.Key("left").Raw(Lines(AreaTextAny(areas, "com_L")));
            json.Key("right").Raw(Lines(AreaTextAny(areas, "com_R")));
            json.EndObject();
            return json.ToString();
        }

        private static string Lines(string text)
        {
            Json.Writer json = new Json.Writer();
            json.BeginArray();
            if (!string.IsNullOrEmpty(text))
            {
                // Split(char, StringSplitOptions) does not exist on Mono's mscorlib.
                string[] parts = text.Split(new char[] { '\n' });
                for (int i = 0; i < parts.Length; i++)
                {
                    string line = parts[i].Trim();
                    if (line.Length > 0)
                    {
                        json.Str(line);
                    }
                }
            }
            json.EndArray();
            return json.ToString();
        }

        private static string RawDump(object gd, Type dataType)
        {            Json.Writer json = new Json.Writer();
            json.BeginObject();
            json.Key("gd_type").Str(Reflect.TypeName(gd));
            json.Key("fields").BeginObject();
            string[] wanted = new string[]
            {
                "shujinkoYaku", "nissiList", "actions", "actionsDid", "actionsCanSelect",
                "chara", "personFromId", "knowTable", "stateFlg", "actionFlg",
                "baseData", "loadFlg", "sceOn"
            };
            for (int i = 0; i < wanted.Length; i++)
            {
                string fieldName = wanted[i];
                object value = null;
                try
                {
                    value = Reflect.Get(gd, fieldName);
                }
                catch (Exception error)
                {
                    value = "ERROR " + error.GetType().Name + ": " + error.Message;
                }
                json.Key(fieldName).BeginObject();
                json.Key("t").Str(Reflect.TypeName(value));
                json.Key("v").Describe(value, 2);
                json.EndObject();
            }
            json.EndObject();

            json.Key("names").Describe(Safe(delegate { return Reflect.Call(gd, "GetNameList"); }), 2);
            json.Key("chara_table").Describe(Safe(delegate { return Reflect.Static(dataType, "Chara"); }), 1);
            json.Key("scenario").Describe(Safe(delegate { return Reflect.Static(dataType, "Scenario"); }), 1);
            json.Key("textarea").Raw(Section(TextAreaProbe));
            json.Key("message_log").Raw(Section(MessageLogProbe));

            json.EndObject();
            return json.ToString();
        }

        // A broken read must never take the whole /state payload down: one bad
        // field should degrade to an "ERROR ..." string, not a 500.
        private static object Safe(Func<object> read)
        {
            try
            {
                return read();
            }
            catch (Exception error)
            {
                Exception real = error is TargetInvocationException && error.InnerException != null
                    ? error.InnerException
                    : error;
                return "ERROR " + real.GetType().Name + ": " + real.Message;
            }
        }

        private static string Section(Func<string> build)
        {
            try
            {
                return build();
            }
            catch (Exception error)
            {
                Exception real = error is TargetInvocationException && error.InnerException != null
                    ? error.InnerException
                    : error;
                return "{\"error\":" + Json.Quote(real.GetType().Name + ": " + real.Message) + "}";
            }
        }

        // The game's role enum uses Japanese romaji (y_Murabito = villager). Map it
        // to the Chinese names the UI actually shows the player.
        private static string ChineseRole(string role)
        {
            if (string.IsNullOrEmpty(role))
            {
                return null;
            }
            switch (role)
            {
                case "y_Murabito": return "船员";
                case "y_Uranai": return "工程师";
                case "y_Reibai": return "医生";
                case "y_Kari": return "守护天使";
                case "y_Kyojin": return "AC追随者";
                case "y_Jinro": return "古诺希亚";
                case "y_Fox": return "虫(BUG)";
                case "y_Lover": return "恋人";
                case "y_Unknown": return "未知";
                default: return role;
            }
        }

        private static string FirstText(object list)
        {
            IList items = list as IList;
            if (items == null)
            {
                return list == null ? null : list.ToString().Trim();
            }
            for (int i = 0; i < items.Count; i++)
            {
                string line = items[i] as string;
                if (!string.IsNullOrEmpty(line))
                {
                    return line.Trim();
                }
            }
            return null;
        }

        private static string JoinText(object list)
        {
            IList items = list as IList;
            if (items == null)
            {
                return list == null ? null : list.ToString().Trim();
            }
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < items.Count; i++)
            {
                string line = items[i] as string;
                if (string.IsNullOrEmpty(line))
                {
                    continue;
                }
                if (sb.Length > 0)
                {
                    sb.Append('\n');
                }
                sb.Append(line.Trim());
            }
            return sb.ToString();
        }

        // textSpriteList holds TMP components (one per laid-out line), not strings,
        // so the plain JoinText above returns nothing for those areas.
        private static string JoinTmpList(object list)
        {
            IList items = list as IList;
            if (items == null || items.Count == 0)
            {
                return null;
            }
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < items.Count; i++)
            {
                string line = Reflect.Get(items[i], "m_text") as string;
                if (string.IsNullOrEmpty(line))
                {
                    continue;
                }
                if (sb.Length > 0)
                {
                    sb.Append('\n');
                }
                sb.Append(line.Trim());
            }
            return sb.ToString();
        }

        // GameData.actions holds every action of the current day; only the ones
        // with canPlayUser set are selectable by the player right now.
        private static string Choices(object actions)
        {
            IList list = actions as IList;
            Json.Writer json = new Json.Writer();
            json.BeginArray();
            if (list != null)
            {
                int emitted = 0;
                for (int i = 0; i < list.Count && emitted < 20; i++)
                {
                    object item = list[i];
                    object playable = Safe(delegate { return Reflect.Get(item, "canPlayUser"); });
                    if (!(playable is bool) || !(bool)playable)
                    {
                        continue;
                    }
                    emitted++;
                    json.BeginObject();
                    json.Key("index").Num(i);
                    json.Key("id").Describe(Safe(delegate { return Reflect.Get(item, "id"); }), 1);
                    json.Key("type").Describe(Safe(delegate { return Reflect.Get(item, "type"); }), 1);
                    json.Key("target").Describe(Safe(delegate { return Reflect.Get(item, "targetP"); }), 1);
                    json.Key("power").Describe(Safe(delegate { return Reflect.Get(item, "power"); }), 1);
                    json.EndObject();
                }
            }
            json.EndArray();
            return json.ToString();
        }

        // Crew roster: names come from the static CharaData master table, state
        // (alive / cold-slept / dead) from the live character objects. True roles
        // are deliberately NOT exposed - that would hand the player the answer.
        private static string Crew(object masterTable, object runtime)
        {
            Dictionary<int, string> names = NameMap(masterTable);
            IList people = runtime as IList;
            Json.Writer json = new Json.Writer();
            json.BeginArray();
            if (people != null)
            {
                for (int i = 0; i < people.Count && i < 20; i++)
                {
                    object person = people[i];
                    object idValue = Safe(delegate { return Reflect.Get(person, "id"); });
                    int id = -1;
                    try
                    {
                        id = Convert.ToInt32(idValue);
                    }
                    catch
                    {
                        id = -1;
                    }
                    string name = null;
                    if (id >= 0 && names.ContainsKey(id))
                    {
                        name = names[id];
                    }
                    json.BeginObject();
                    json.Key("id").Num(id);
                    json.Key("name").Str(name);
                    json.Key("state").Describe(Safe(delegate { return Reflect.Get(person, "doa"); }), 1);
                    json.Key("place").Describe(Safe(delegate { return Reflect.Get(person, "place"); }), 1);
                    json.EndObject();
                }
            }
            json.EndArray();
            return json.ToString();
        }

        private static Dictionary<int, string> NameMap(object masterTable)
        {
            Dictionary<int, string> map = new Dictionary<int, string>();
            IList list = masterTable as IList;
            if (list == null && masterTable != null)
            {
                string[] guesses = new string[] { "chara", "list", "data", "values", "table", "items", "charaList" };
                for (int i = 0; i < guesses.Length && list == null; i++)
                {
                    list = Reflect.Get(masterTable, guesses[i]) as IList;
                }
            }
            if (list == null)
            {
                return map;
            }
            for (int i = 0; i < list.Count; i++)
            {
                object entry = list[i];
                if (entry == null)
                {
                    continue;
                }
                object idValue = Safe(delegate { return Reflect.Get(entry, "id"); });
                object nameValue = Safe(delegate { return Reflect.Get(entry, "name"); });
                if (idValue == null || nameValue == null)
                {
                    continue;
                }
                try
                {
                    map[Convert.ToInt32(idValue)] = nameValue.ToString();
                }
                catch
                {
                    // entry without a usable id
                }
            }
            return map;
        }

        // Full field dump for a type: static fields plus, when the type is the
        // live GameData, every instance field. This is what makes schema design
        // possible without rebuilding the DLL after each guess.
        // Method signatures for a type: this is how the direct-call endpoints get
        // their argument lists without guessing.
        public static string Methods(string typeName)
        {
            Json.Writer json = new Json.Writer();
            json.BeginObject();
            Type type = Reflect.Find(typeName);
            json.Key("ok").Bool(type != null);
            json.Key("type").Str(typeName);
            if (type == null)
            {
                json.Key("error").Str("type not found");
                json.EndObject();
                return json.ToString();
            }
            json.Key("methods").BeginArray();
            MethodInfo[] methods = type.GetMethods(BindingFlags.Public | BindingFlags.NonPublic
                | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly);
            for (int i = 0; i < methods.Length; i++)
            {
                json.BeginObject();
                json.Key("name").Str(methods[i].Name);
                json.Key("static").Bool(methods[i].IsStatic);
                json.Key("ret").Str(methods[i].ReturnType.Name);
                json.Key("params").BeginArray();
                ParameterInfo[] parameters = methods[i].GetParameters();
                for (int k = 0; k < parameters.Length; k++)
                {
                    json.Str(parameters[k].ParameterType.Name + " " + parameters[k].Name);
                }
                json.EndArray();
                json.EndObject();
            }
            json.EndArray();
            json.EndObject();
            return json.ToString();
        }

        public static string Dump(string typeName, int limit, bool findInstance)
        {            Json.Writer json = new Json.Writer();
            json.BeginObject();
            json.Key("ok").Bool(true);
            json.Key("type").Str(typeName);

            Type type = Reflect.Find(typeName);
            if (type == null)
            {
                json.Key("ok").Bool(false);
                json.Key("error").Str("type not found");
                json.EndObject();
                return json.ToString();
            }

            object instance = null;
            Type dataType = Reflect.Find("gnosia.Data");
            object gameData = Reflect.Static(dataType, "gd");
            if (gameData != null && type.IsInstanceOfType(gameData))
            {
                instance = gameData;
            }
            if (instance == null && findInstance)
            {
                // Live MonoBehaviour found by type: this is how a screen object's
                // fields (and the real day counter) can be inspected.
                UnityEngine.Object[] live = Resources.FindObjectsOfTypeAll(type);
                if (live != null && live.Length > 0)
                {
                    instance = live[0];
                }
            }
            json.Key("has_instance").Bool(instance != null);

            json.Key("static_fields").BeginObject();
            FieldInfo[] statics = type.GetFields(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
            int emitted = 0;
            for (int i = 0; i < statics.Length && emitted < limit; i++)
            {
                if (statics[i].IsLiteral)
                {
                    continue;
                }
                json.Key(statics[i].Name).BeginObject();
                json.Key("t").Str(statics[i].FieldType.Name);
                json.Key("v").Describe(Safe(delegate { return statics[i].GetValue(null); }), 1);
                json.EndObject();
                emitted++;
            }
            json.EndObject();

            json.Key("instance_fields").BeginObject();
            if (instance != null)
            {
                FieldInfo[] fields = type.GetFields(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
                emitted = 0;
                for (int i = 0; i < fields.Length && emitted < limit; i++)
                {
                    FieldInfo field = fields[i];
                    json.Key(field.Name).BeginObject();
                    json.Key("t").Str(field.FieldType.Name);
                    json.Key("v").Describe(Safe(delegate { return field.GetValue(instance); }), 1);
                    json.EndObject();
                    emitted++;
                }
            }
            json.EndObject();

            json.EndObject();
            return json.ToString();
        }

        // ---- direct actions (no synthetic mouse events) --------------------

        // Move2Screen drives itself from selectX / selectTgt / isDicision, so the
        // same state the UI sets can be written directly: SelectTarget(place,index)
        // puts the cursor there and isDicision = true is exactly what a click sets.
        public static string Move(int place)
        {
            Json.Writer json = new Json.Writer();
            json.BeginObject();
            object move = Reflect.FirstInstance("application.Move2Screen");
            if (move == null)
            {
                json.Key("ok").Bool(false);
                json.Key("error").Str("the move screen is not open");
                json.EndObject();
                return json.ToString();
            }

            IList selectList = Reflect.Get(move, "selectList") as IList;
            int index = -1;
            if (selectList != null)
            {
                for (int i = 0; i < selectList.Count; i++)
                {
                    int id;
                    try
                    {
                        id = Convert.ToInt32(selectList[i]);
                    }
                    catch
                    {
                        continue;
                    }
                    if (id == place)
                    {
                        index = i;
                        break;
                    }
                }
            }

            if (index < 0)
            {
                json.Key("ok").Bool(false);
                json.Key("error").Str("that place is not reachable right now");
                json.Key("reachable").Describe(selectList, 2);
                json.EndObject();
                return json.ToString();
            }

            Reflect.Set(move, "isMouseEnable", true);
            Reflect.Call(move, "SelectTarget", place, index);
            bool decided = Reflect.Set(move, "isDicision", true);

            json.Key("ok").Bool(true);
            json.Key("place").Num(place);
            json.Key("index").Num(index);
            json.Key("flagged").Bool(decided);
            json.Key("note").Str("cursor set and confirm flag raised; the screen performs the move on its next update");
            json.EndObject();
            return json.ToString();
        }

        // ---- advance dialogue ---------------------------------------------
        // ScriptParser.MyUpdate clears isSkipPressed at the TOP of every frame and
        // then re-derives it from the controller context, so writing the field from
        // Update() is always overwritten before DoScript reads it. That is why the
        // first attempt never advanced anything.
        //
        // The fix is to sit between those two steps: DoScript is the method that
        // actually consumes isSkipPressed, so a Harmony prefix on it can raise the
        // flag for exactly one call. No keyboard, no mouse, no foreground window.
        private static int _pendingAdvance;

        // Every screen that answers Enter with "confirm the highlighted row"
        // instead of "next line". Pressing through one of these is exactly how a
        // vote got cast for the default cursor (row 1 = 塞思) before anybody had
        // picked a target: /action/advance used to be a blind Enter, and the vote
        // screen consumed it. The MCP layer always guarded against this; the raw
        // HTTP route has to guard itself too, because a caller without the MCP
        // in front of it sees the same blind key.
        private static readonly HashSet<string> DialogueOnlyScreens = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "InterfaceScreen", "BgScreen", "CharaScreen", "ColorScreen",
            "FadeScreen", "Fade2Screen", "LightBallScreen", "CopyScreen", "Copy2Screen"
        };

        private static readonly HashSet<string> CursorOwnedScreens = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "VoteScreen", "Move2Screen", "MyRoomScreen", "SelectTgtScreen", "SelectScreen",
            "YesNoDialogScreen", "ResultScreen", "MessageLogScreen",
            "GameMenuScreen", "GameMenuSkillScreen", "GameMenuHelpScreen", "GameMenuLoadScreen",
            "GameMenuSaveScreen", "GameMenuOptionScreen", "GameMenuKeyConfigScreen",
            "CreateSlotScreen", "LoadSlotScreen", "SaveSlotScreen", "TitleScreen",
            "MakeLoopScreen", "TakashiSetScreen", "SexSelWindow", "ColorSelWindow", "RegistWindow"
        };

        private static List<object> ShownScreens()
        {
            List<object> shown = new List<object>();
            Type screenBase = Reflect.Find("application.Screen");
            if (screenBase == null)
            {
                return shown;
            }
            UnityEngine.Object[] all = Resources.FindObjectsOfTypeAll(screenBase);
            if (all == null)
            {
                return shown;
            }
            for (int i = 0; i < all.Length; i++)
            {
                object screen = all[i];
                if (screen == null)
                {
                    continue;
                }
                object state = Reflect.Get(screen, "m_state");
                if (string.Equals(state == null ? "" : state.ToString(), "show", StringComparison.OrdinalIgnoreCase))
                {
                    shown.Add(screen);
                }
            }
            return shown;
        }

        // The story's own "what do I say" candidates are drawn as yellow text in a
        // text area, not in the command column. One yellow line is an inner
        // monologue and Enter is harmless; two or more are an actual choice, and
        // Enter silently picks the first one - that is how a line got spoken for
        // the player twice in a row. Counting them is crude but it is the only
        // signal available without knowing which screen type draws them.
        private static int YellowCandidateLines()
        {
            int count = 0;
            List<IDictionary> maps = TextAreaMaps();
            for (int i = 0; i < maps.Count; i++)
            {
                IDictionary map = maps[i];
                if (map == null)
                {
                    continue;
                }
                foreach (object key in map.Keys)
                {
                    string text = AreaText(map, key == null ? null : key.ToString());
                    if (!string.IsNullOrEmpty(text) && text.IndexOf("<color=\"yellow\">", StringComparison.Ordinal) >= 0)
                    {
                        // Count lines by hand: this Unity Mono profile has no
                        // Split(char, StringSplitOptions) overload.
                        int lines = 1;
                        for (int c = 0; c < text.Length; c++)
                        {
                            if (text[c] == '\n')
                            {
                                lines++;
                            }
                        }
                        count += lines;
                    }
                }
            }
            return count;
        }

        // Names of the screens that currently refuse a blind Enter.
        private static List<string> BlindPressBlockers()
        {
            List<string> blockers = new List<string>();
            List<object> shown = ShownScreens();
            for (int i = 0; i < shown.Count; i++)
            {
                string name = shown[i].GetType().Name;
                if (DialogueOnlyScreens.Contains(name))
                {
                    continue;
                }
                // A yes/no dialog with m_canSelect == false is a notice ("X was put
                // into cold sleep"), not a question: it only needs one Enter.
                if (string.Equals(name, "YesNoDialogScreen", StringComparison.OrdinalIgnoreCase))
                {
                    object canSelect = Reflect.Get(shown[i], "m_canSelect");
                    if (canSelect is bool && !(bool)canSelect)
                    {
                        continue;
                    }
                    blockers.Add(name);
                    continue;
                }
                if (CursorOwnedScreens.Contains(name))
                {
                    blockers.Add(name);
                    continue;
                }
                int max = (int)AsNumber(Reflect.Get(shown[i], "selectMax"));
                if (max > 0)
                {
                    blockers.Add(name);
                }
            }
            // The 发言 button is the game's own "you may speak now". Pressing Enter
            // here does not advance - it confirms whatever row the speech menu has
            // highlighted, which is how the player's line got picked for them.
            object iface = ActiveInstance("application.InterfaceScreen");
            if (iface != null)
            {
                IDictionary btnMap = Reflect.Get(iface, "m_spriteMap") as IDictionary;
                int selNow = (int)AsNumber(Reflect.Get(iface, "select"));
                if (selNow >= 0)
                {
                    blockers.Add("speak_menu_open");
                }
                else if (VisibleByKey(btnMap, 1000))
                {
                    blockers.Add("speak_available");
                }
            }
            if (blockers.Count == 0 && YellowCandidateLines() >= 2)
            {
                blockers.Add("yellow_speech_candidates");
            }
            return blockers;
        }

        public static string Advance()
        {
            Json.Writer json = new Json.Writer();
            json.BeginObject();
            List<string> blockers = BlindPressBlockers();
            if (blockers.Count > 0)
            {
                json.Key("ok").Bool(false);
                json.Key("stopped_because").Str("screen_owns_input");
                json.Key("blocked_by").BeginArray();
                for (int i = 0; i < blockers.Count; i++)
                {
                    json.Str(blockers[i]);
                }
                json.EndArray();
                bool speakBlocker = blockers.Contains("speak_available") || blockers.Contains("speak_menu_open");
                json.Key("note").Str(speakBlocker
                    ? "The 发言 button is on screen, so Enter would answer with the highlighted row instead of advancing. Press W first (/action/press?action=3), read state.speak.options, then pick a row. Nothing was pressed."
                    : "Enter on this screen means 'confirm the highlighted row', not 'next'. Answer it with the screen's own route: /action/vote, /action/ui, /action/setup ... Nothing was pressed.");
                json.EndObject();
                return json.ToString();
            }
            object parser = Reflect.FirstInstance("coreSystem.ScriptParser");
            if (parser == null)
            {
                json.Key("ok").Bool(false);
                json.Key("error").Str("script parser not found");
                json.EndObject();
                return json.ToString();
            }
            bool wasWaiting = Reflect.Get(parser, "waitNext") is bool && (bool)Reflect.Get(parser, "waitNext");
            bool patched = _doScriptPatched;
            if (patched)
            {
                Interlocked.Exchange(ref _pendingAdvance, 1);
            }
            // The script-queue hook only fires while a script is running. Dialogue
            // boxes that just wait for "next" are polled through the input context
            // instead, so raise a short virtual Enter as well.
            bool pressed = _inputPatched;
            if (pressed)
            {
                // Same cap as /action/press: advance must not leave a held Enter
                // behind for the next screen (that is what voted row 0 at the vote
                // screen and walked into the room on the map).
                ArmPress(0, 40);
            }
            json.Key("ok").Bool(true);
            json.Key("was_waiting").Bool(wasWaiting);
            json.Key("patched").Bool(patched);
            json.Key("virtual_enter").Bool(pressed);
            json.Key("note").Str("advance requested; no keyboard or foreground window involved");
            json.EndObject();
            return json.ToString();
        }

        internal static bool _doScriptPatched;
        internal static bool _inputPatched;
        internal static bool _clickPatched;

        // A virtual button press: sce.SampleUtil.Input.ControllerContext is what
        // every screen polls, and it is fed from the real keyboard/mouse. Holding
        // one action id for a few dozen milliseconds is indistinguishable from the
        // player pressing that key - and it needs no foreground window, which is
        // what stops the game from stealing focus mid-sentence.
        private static int _pressAction = -1;
        private static int _pressUntil;
        private static int _pressFrame;

        // A virtual press must not outlive the screen that is reading it.
        //
        // Every screen polls the same "is this button held" query, so whatever is
        // left of the window is also seen by the screen that comes next. A 90-150ms
        // hold spans the transition: the press that started the vote was also read
        // by VoteScreen as a fresh confirm (it voted row 0 with nobody picked), and
        // the press that opened the map was read by MyRoomScreen (it walked straight
        // into the player's own room). Two frames is what a real key-down looks like.
        private const int PressMaxFrames = 2;
        private const int PressMaxMillis = 50;

        private static void ArmPress(int action, int millis)
        {
            if (millis <= 0 || millis > 1000)
            {
                millis = 90;
            }
            if (millis > PressMaxMillis)
            {
                millis = PressMaxMillis;
            }
            _pressAction = action;
            _pressFrame = Time.frameCount;
            _pressUntil = Environment.TickCount + millis;
        }

        public static string Press(int action, int millis)
        {
            Json.Writer json = new Json.Writer();
            json.BeginObject();
            if (!_inputPatched)
            {
                json.Key("ok").Bool(false);
                json.Key("error").Str("input hook is not installed");
                json.EndObject();
                return json.ToString();
            }
            if (millis <= 0 || millis > 1000)
            {
                millis = 90;
            }
            ArmPress(action, millis);
            json.Key("ok").Bool(true);
            json.Key("action").Num(action);
            json.Key("held_ms").Num(Math.Min(millis, PressMaxMillis));
            json.Key("max_frames").Num(PressMaxFrames);
            json.Key("note").Str("the game sees this button as held for at most 2 frames");
            json.EndObject();
            return json.ToString();
        }

        internal static void InstallHooks()
        {
            try
            {
                Type parser = Reflect.Find("coreSystem.ScriptParser");
                if (parser != null)
                {
                    MethodInfo target = parser.GetMethod("DoScript",
                        BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance,
                        null, new Type[] { typeof(float) }, null);
                    MethodInfo prefix = typeof(Probe).GetMethod("DoScriptPrefix",
                        BindingFlags.NonPublic | BindingFlags.Static);
                    if (target != null && prefix != null)
                    {
                        _harmony.Patch(target, new HarmonyMethod(prefix));
                        _doScriptPatched = true;
                    }
                }
            }
            catch (Exception)
            {
                _doScriptPatched = false;
            }

            try
            {
                Type context = Reflect.Find("sce.SampleUtil.Input.ControllerContext");
                if (context != null)
                {
                    MethodInfo prefix = typeof(Probe).GetMethod("IsButtonPressedPrefix",
                        BindingFlags.NonPublic | BindingFlags.Static);
                    MethodInfo pressed = context.GetMethod("IsButtonPressed",
                        BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance,
                        null, new Type[] { typeof(int) }, null);
                    MethodInfo down = context.GetMethod("IsButtonDown",
                        BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance,
                        null, new Type[] { typeof(int) }, null);
                    if (pressed != null && prefix != null)
                    {
                        _harmony.Patch(pressed, new HarmonyMethod(prefix));
                        _inputPatched = true;
                    }
                    // Confirmations (menu items, command window) listen to the
                    // "pressed this frame" edge, not to the held state, so the
                    // same virtual window must cover both.
                    if (down != null && prefix != null)
                    {
                        _harmony.Patch(down, new HarmonyMethod(prefix));
                        _inputPatched = true;
                    }
                }
            }
            catch (Exception)
            {
                _inputPatched = false;
            }

            try
            {
                // UnityEngine.Input lives in InputLegacyModule; resolving by name
                // keeps the plugin free of a hard reference to that assembly.
                Type input = Reflect.Find("UnityEngine.Input");
                MethodInfo gmbd = input == null ? null : input.GetMethod("GetMouseButtonDown",
                    BindingFlags.Public | BindingFlags.Static, null, new Type[] { typeof(int) }, null);
                MethodInfo prefix = typeof(Probe).GetMethod("GetMouseButtonDownPrefix",
                    BindingFlags.NonPublic | BindingFlags.Static);
                if (gmbd != null && prefix != null)
                {
                    _harmony.Patch(gmbd, new HarmonyMethod(prefix));
                    _clickPatched = true;
                }
            }
            catch (Exception)
            {
                _clickPatched = false;
            }
        }

        private static Harmony _harmony;

        internal static void InitHarmony(string id)
        {
            _harmony = new Harmony(id);
        }

        // Runs before the script engine consumes isSkipPressed. One pending advance
        // = one skipped wait, which is exactly one line of dialogue.
        private static void DoScriptPrefix(object __instance)
        {
            if (Interlocked.CompareExchange(ref _pendingAdvance, 0, 0) <= 0)
            {
                return;
            }
            Interlocked.Decrement(ref _pendingAdvance);
            Reflect.Set(__instance, "isSkipPressed", true);
        }

        private static bool IsButtonPressedPrefix(int __0, ref bool __result)
        {
            if (__0 == _pressAction
                && Environment.TickCount < _pressUntil
                && Time.frameCount <= _pressFrame + PressMaxFrames)
            {
                __result = true;
                return false;
            }
            return true;
        }

        // ---- command list (发言) ------------------------------------------
        // EnterComandButton only raises isDicision; the real choice is the "select"
        // field. So: /action/select moves the cursor without confirming (safe probe),
        // /action/command sets it and raises the flag.
        public static string SelectCommand(int index)
        {
            return CommandCore(index, false);
        }

        public static string CommitCommand(int index)
        {
            return CommandCore(index, true);
        }

        private static string CommandCore(int index, bool commit)
        {
            Json.Writer json = new Json.Writer();
            json.BeginObject();
            object screen = ActiveInstance("application.InterfaceScreen");
            if (screen == null)
            {
                json.Key("ok").Bool(false);
                json.Key("error").Str("the interface screen is not loaded");
                json.EndObject();
                return json.ToString();
            }

            // A stale isDicision wedges the whole screen: MyUpdate jumps straight
            // into the commit branch every frame and never gets back to normal
            // input handling. Always start from a clean slate, then raise it once.
            bool cleared = Reflect.Set(screen, "isDicision", false);
            Reflect.Set(screen, "isMouseEnable", true);

            // Writing "select" while the command list has no rows is what left an
            // empty striped panel on screen twice. The list only exists once the
            // 发言 window is open, so refuse instead of corrupting the screen.
            object counts = Reflect.Get(screen, "selectNum");
            IList countList = counts as IList;
            int available = countList != null && countList.Count > 0 ? (int)AsNumber(countList[0]) : 0;
            if (available <= 0)
            {
                json.Key("ok").Bool(false);
                json.Key("error").Str("the command list is not open right now; open 发言 first, otherwise the cursor lands on nothing");
                json.Key("select_num0").Num(available);
                json.EndObject();
                return json.ToString();
            }
            // "select" is the COLUMN index and MyUpdate recomputes it from the real
            // mouse position every frame, so writing it is pointless - it snaps back
            // within a frame. The row being pointed at is selectPos[column].
            int column = (int)AsNumber(Reflect.Get(screen, "select"));
            if (column < 0)
            {
                column = 0;
            }
            Array pos = Reflect.Get(screen, "selectPos") as Array;
            bool posSet = false;
            // Highlight first, and let the GAME draw it: PointerEnterComand
            // returns immediately when index already equals selectPos[0], so
            // writing the row before the call (as an earlier build did) meant
            // the yellow frame never moved - picking row 0 looked right, any
            // other row silently executed while the cursor stayed put.
            Reflect.Set(screen, "isMouseEnable", true);
            Reflect.Set(screen, "interfaceUpdate", false);
            Reflect.Call(screen, "PointerEnterComand", index);
            // Fallback only: if the handler bailed (e.g. the column had already
            // switched away from the command column), make sure the row the
            // game will execute is still the one the caller asked for.
            if (pos != null && column < pos.Length)
            {
                if ((int)AsNumber(pos.GetValue(column)) != index)
                {
                    pos.SetValue(index, column);
                }
                posSet = true;
            }
            bool flagged = false;
            if (commit)
            {
                // isDicision is the "确定" button on its own: EnterActionButton
                // raises it without touching isSpeak, and MyUpdate consumes it in
                // both the command column and the target column. Setting isSpeak
                // here (as an earlier build did) is the same as pressing 发言
                // again - it makes MyUpdate rebuild the command list right after
                // the commit and wrecks the target column it just opened.
                flagged = Reflect.Set(screen, "isDicision", true);
            }

            json.Key("ok").Bool(true);
            json.Key("index").Num(index);
            json.Key("committed").Bool(commit);
            json.Key("cleared_stale_flag").Bool(cleared);
            json.Key("select_pos_set").Bool(posSet);
            json.Key("flagged").Bool(flagged);
            json.Key("select_now").Num(AsNumber(Reflect.Get(screen, "select")));
            json.Key("column_used").Num(column);
            json.Key("select_pos_now").Describe(Reflect.Get(screen, "selectPos"), 0);
            json.Key("select_pos").Str(IntList(Reflect.Get(screen, "selectPos")));
            json.Key("dicision_now").Describe(Reflect.Get(screen, "isDicision"), 0);
            List<IDictionary> areas = TextAreaMaps();
            json.Key("selected_name").Str(AreaTextAny(areas, "com_Name"));
            json.Key("selected_desc").Str(AreaTextAny(areas, "com_Desc"));
            json.EndObject();
            return json.ToString();
        }

        // Which screens are visible right now, with their cursor state. This is
        // the map for /action/ui: the model asks here, then drives that screen.
        public static string Screens()
        {
            Json.Writer json = new Json.Writer();
            json.BeginObject();
            json.Key("ok").Bool(true);
            json.Key("screens").BeginArray();
            Type screenBase = Reflect.Find("application.Screen");
            if (screenBase != null)
            {
                UnityEngine.Object[] all = Resources.FindObjectsOfTypeAll(screenBase);
                if (all != null)
                {
                    for (int i = 0; i < all.Length; i++)
                    {
                        object screen = all[i];
                        if (screen == null)
                        {
                            continue;
                        }
                        object state = Reflect.Get(screen, "m_state");
                        string stateText = state == null ? "" : state.ToString();
                        if (!string.Equals(stateText, "show", StringComparison.OrdinalIgnoreCase))
                        {
                            continue;
                        }
                        json.BeginObject();
                        json.Key("type").Str(screen.GetType().Name);
                        json.Key("full").Str(screen.GetType().FullName);
                        json.Key("select").Describe(Reflect.Get(screen, "selectTgt"), 0);
                        json.Key("select_max").Describe(Reflect.Get(screen, "selectMax"), 0);
                        // A yes/no dialog answers to isYes/isNo, not to Enter. Flag it
                        // so callers stop blind-pressing and pick 是/否 explicitly.
                        // These fields are private - GetField without flags misses them.
                        const BindingFlags screenFlags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;
                        Type screenType = screen.GetType();
                        if (screenType.GetField("isYes", screenFlags) != null && screenType.GetField("isNo", screenFlags) != null)
                        {
                            json.Key("yes_no").Bool(true);
                            // can_select true means two real answers; false means it is
                            // just a 继续 notice with a single button.
                            json.Key("can_select").Describe(Reflect.Get(screen, "m_canSelect"), 0);
                            json.Key("wait_time").Describe(Reflect.Get(screen, "waitTime"), 0);
                            json.Key("dialog").Str(AreaTextAny(TextAreaMaps(), "mes"));
                        }
                        json.Key("areas").Describe(TextAreaKeys(screen), 1);
                        json.EndObject();
                    }
                }
            }
            json.EndArray();
            json.EndObject();
            return json.ToString();
        }

        // Every text area on every screen, empty ones included. Used to discover
        // where a piece of UI lives (the round counter, for instance) instead of
        // guessing key names.
        public static string Areas()
        {
            Json.Writer json = new Json.Writer();
            json.BeginObject();
            json.Key("ok").Bool(true);
            json.Key("screens").BeginArray();
            Type screenType = Reflect.Find("application.Screen");
            if (screenType != null)
            {
                UnityEngine.Object[] all = Resources.FindObjectsOfTypeAll(screenType);
                if (all != null)
                {
                    for (int i = 0; i < all.Length; i++)
                    {
                        object screen = all[i];
                        if (screen == null)
                        {
                            continue;
                        }
                        object state = Reflect.Get(screen, "m_state");
                        string stateText = state == null ? "" : state.ToString();
                        if (!string.Equals(stateText, "show", StringComparison.OrdinalIgnoreCase))
                        {
                            continue;
                        }
                        IDictionary map = Reflect.Get(screen, "m_textAreaMap") as IDictionary;
                        if (map == null || map.Count == 0)
                        {
                            continue;
                        }
                        json.BeginObject();
                        json.Key("type").Str(screen.GetType().Name);
                        json.Key("areas").BeginObject();
                        int emitted = 0;
                        foreach (DictionaryEntry entry in map)
                        {
                            if (emitted >= 80)
                            {
                                break;
                            }
                            string key = entry.Key == null ? null : entry.Key.ToString();
                            if (string.IsNullOrEmpty(key))
                            {
                                continue;
                            }
                            json.Key(key).Str(AreaText(map, key));
                            emitted++;
                        }
                        json.EndObject();
                        json.EndObject();
                    }
                }
            }
            json.EndArray();
            json.EndObject();
            return json.ToString();
        }

        // Generic single-field write, for poking at a screen while working out
        // which flag the game actually consumes. Reports before and after.
        public static string SetField(string screenName, string field, string raw)
        {
            Json.Writer json = new Json.Writer();
            json.BeginObject();
            string full = screenName.IndexOf('.') >= 0 ? screenName : "application." + screenName;
            object screen = ActiveInstance(full);
            if (screen == null)
            {
                json.Key("ok").Bool(false);
                json.Key("error").Str(full + " is not on screen right now");
                json.EndObject();
                return json.ToString();
            }
            FieldInfo info = screen.GetType().GetField(field,
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            if (info == null)
            {
                json.Key("ok").Bool(false);
                json.Key("error").Str("no field " + field + " on " + full);
                json.EndObject();
                return json.ToString();
            }
            object before = info.GetValue(screen);
            try
            {
                object value = raw == null ? null : Convert.ChangeType(raw, info.FieldType);
                info.SetValue(screen, value);
                json.Key("ok").Bool(true);
                json.Key("field").Str(field);
                json.Key("type").Str(info.FieldType.Name);
                json.Key("before").Describe(before, 0);
                json.Key("after").Describe(info.GetValue(screen), 0);
            }
            catch (Exception error)
            {
                json.Key("ok").Bool(false);
                json.Key("error").Str(error.Message);
            }
            json.EndObject();
            return json.ToString();
        }

        // Every UI button in this game funnels through
        //     if (!Input.GetMouseButtonDown(0)) return;
        //     flag = true;
        // so the whole click path can be driven by answering that one static call.
        // No cursor movement, no coordinates, no foreground window - and it is the
        // game's own handler that runs, not a state write we guessed at.
        private static int _virtualClick;

        private static bool GetMouseButtonDownPrefix(int __0, ref bool __result)
        {
            if (__0 != 0)
            {
                return true;
            }
            if (Interlocked.CompareExchange(ref _virtualClick, 0, 0) <= 0)
            {
                return true;
            }
            Interlocked.Decrement(ref _virtualClick);
            __result = true;
            return false;
        }

        public static string Click(string screenName, string method, int index, bool armClick)
        {
            Json.Writer json = new Json.Writer();
            json.BeginObject();
            string full = screenName.IndexOf('.') >= 0 ? screenName : "application." + screenName;
            object screen = ActiveInstance(full);
            if (screen == null)
            {
                json.Key("ok").Bool(false);
                json.Key("error").Str(full + " is not on screen right now");
                json.EndObject();
                return json.ToString();
            }
            MethodInfo target = screen.GetType().GetMethod(method,
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance,
                null, new Type[] { typeof(int) }, null);
            if (target == null)
            {
                json.Key("ok").Bool(false);
                json.Key("error").Str("no method " + method + "(int) on " + full);
                json.EndObject();
                return json.ToString();
            }
            Reflect.Set(screen, "isMouseEnable", true);
            if (armClick)
            {
                Interlocked.Exchange(ref _virtualClick, 1);
            }
            try
            {
                target.Invoke(screen, new object[] { index });
                json.Key("ok").Bool(true);
                json.Key("screen").Str(screen.GetType().Name);
                json.Key("method").Str(method);
                json.Key("index").Num(index);
                json.Key("note").Str("the screen's own handler ran, as if that button was clicked");
            }
            catch (Exception error)
            {
                json.Key("ok").Bool(false);
                json.Key("error").Str(error.Message);
            }
            json.EndObject();
            return json.ToString();
        }

        // Target picking after a command that needs one (怀疑/袒护/vote...).
        // The target panel is column 1, the highlighted name is drawn into the
        // "mainname" text area, and the pick is committed the same way: set the
        // row, then let MyUpdate consume isDicision while select == 1.
        // The target column draws faces and leaves the name plate alone, which is
        // why reading `mainname` came back null or held the speaker's name. The
        // rows map to characters through the same bitmask LookTargetChara walks:
        //     idx = row (1-based); for i = 1..totalNum-1:
        //         if (((peopleFlg[k] >> (i & 31)) & 1) != 0) { if (--idx == 0) return i; }
        // so row n is simply the n-th set bit of that mask, counted from 1.
        // Which mask (0 or 1) applies depends on needSelect; return both lists so
        // the caller can pick the one whose length matches the row count.
        public static string TargetList()
        {
            Json.Writer json = new Json.Writer();
            json.BeginObject();
            object screen = ActiveInstance("application.InterfaceScreen");
            if (screen == null)
            {
                json.Key("ok").Bool(false);
                json.Key("error").Str("the interface screen is not loaded");
                json.EndObject();
                return json.ToString();
            }
            IList counts = Reflect.Get(screen, "selectNum") as IList;
            int rows = counts != null && counts.Count > 1 ? (int)AsNumber(counts[1]) : 0;
            if (rows <= 0)
            {
                json.Key("ok").Bool(false);
                json.Key("error").Str("no target list on screen");
                json.EndObject();
                return json.ToString();
            }

            int select = (int)AsNumber(Reflect.Get(screen, "select"));
            IList posList = Reflect.Get(screen, "selectPos") as IList;
            int cursor = posList != null && posList.Count > select ? (int)AsNumber(posList[select]) : -1;

            object gd = ActiveInstance("gnosia.GameData");
            // The character master table (id -> name) hangs off gnosia.Data, not
            // gnosia.GameData. Reading it from the wrong type returns null, and
            // NameMap then yields an empty map - every row comes back null.
            Type dataType = Reflect.Find("gnosia.Data");
            Dictionary<int, string> names = NameMap(Reflect.Static(dataType, "Chara"));
            IList people = Reflect.Get(gd, "chara") as IList;
            int totalNum = (int)AsNumber(Reflect.Get(Reflect.Get(gd, "baseData"), "totalNum"));
            Array flags = Reflect.Get(gd, "peopleFlg") as Array;

            json.Key("ok").Bool(true);
            json.Key("rows").Num(rows);
            json.Key("total").Num(totalNum);
            json.Key("cursor").Num(cursor);
            for (int slot = 0; slot < 2; slot++)
            {
                long mask = 0;
                try
                {
                    if (flags != null && flags.Length > slot)
                    {
                        mask = Convert.ToInt64(flags.GetValue(slot));
                    }
                }
                catch
                {
                    mask = 0;
                }
                json.Key(slot == 0 ? "names0" : "names1").BeginArray();
                if (people != null)
                {
                    for (int i = 1; i < totalNum && i < people.Count; i++)
                    {
                        if (((mask >> (i & 31)) & 1L) == 0L)
                        {
                            continue;
                        }
                        object person = people[i];
                        int id = -1;
                        try
                        {
                            id = Convert.ToInt32(Safe(delegate { return Reflect.Get(person, "id"); }));
                        }
                        catch
                        {
                            id = -1;
                        }
                        string name = id >= 0 && names.ContainsKey(id) ? names[id] : null;
                        json.Str(name);
                    }
                }
                json.EndArray();
            }
            json.EndObject();
            return json.ToString();
        }

        public static string Target(int index, bool confirm)
        {
            Json.Writer json = new Json.Writer();
            json.BeginObject();
            object screen = ActiveInstance("application.InterfaceScreen");
            if (screen == null)
            {
                json.Key("ok").Bool(false);
                json.Key("error").Str("the interface screen is not loaded");
                json.EndObject();
                return json.ToString();
            }
            IList counts = Reflect.Get(screen, "selectNum") as IList;
            int targetRows = counts != null && counts.Count > 1 ? (int)AsNumber(counts[1]) : 0;
            if (targetRows <= 0)
            {
                json.Key("ok").Bool(false);
                json.Key("error").Str("no target list on screen - pick a command that needs a target first");
                json.EndObject();
                return json.ToString();
            }
            if (index < 0 || index >= targetRows)
            {
                json.Key("ok").Bool(false);
                json.Key("error").Str("target index out of range 0.." + (targetRows - 1));
                json.EndObject();
                return json.ToString();
            }
            Reflect.Set(screen, "isMouseEnable", true);
            Reflect.Set(screen, "select", 1);
            // PointerEnterTgt IS the game's own "cursor moved onto target row"
            // handler: it writes selectPos[1], calls LookTargetChara (which
            // repaints the NAME plate) and latches interfaceUpdate. Writing
            // selectPos by hand looked right in the response but the picture
            // never moved - MyUpdate rebuilds the target column and re-zeroes
            // that slot, so the highlight snapped back to row 0.
            Reflect.Set(screen, "interfaceUpdate", false);
            Reflect.Call(screen, "PointerEnterTgt", index);
            bool flagged = false;
            if (confirm)
            {
                Reflect.Set(screen, "isDicision", false);
                flagged = Reflect.Set(screen, "isDicision", true);
            }
            json.Key("ok").Bool(true);
            json.Key("index").Num(index);
            json.Key("target_rows").Num(targetRows);
            json.Key("confirmed").Bool(flagged);
            json.Key("name").Str(AreaTextAny(TextAreaMaps(), "mainname"));
            json.Key("select_pos").Str(IntList(Reflect.Get(screen, "selectPos")));
            json.Key("select_now").Num(AsNumber(Reflect.Get(screen, "select")));
            json.EndObject();
            return json.ToString();
        }

        // Voting is a two-axis grid: VoteScreen packs its cursor as
        // selectTgt = selectX * 6 + selectY, and its own SelectTarget(x, y)
        // writes all three fields plus moves the sprite. Writing selectTgt alone
        // (what this used to do) cast the right vote while the cursor sat on
        // somebody else - the same silent class of bug as the command list.
        public static string Vote(int index, bool confirm)
        {
            Json.Writer json = new Json.Writer();
            json.BeginObject();
            object screen = ActiveInstance("application.VoteScreen");
            if (screen == null)
            {
                json.Key("ok").Bool(false);
                json.Key("error").Str("the vote screen is not up right now");
                json.EndObject();
                return json.ToString();
            }
            int x = index / 6;
            int y = index % 6;
            Reflect.Set(screen, "isMouseEnable", true);
            // SelectTarget bails while the screen is animating (state != 0), so
            // report the state instead of pretending the move happened.
            object stateBefore = Reflect.Get(screen, "state");
            if (index >= 0)
            {
                Reflect.Call(screen, "SelectTarget", x, y);
            }
            else
            {
                x = (int)AsNumber(Reflect.Get(screen, "selectX"));
                y = (int)AsNumber(Reflect.Get(screen, "selectY"));
            }
            bool flagged = false;
            if (confirm)
            {
                Reflect.Set(screen, "isDicision", false);
                flagged = Reflect.Set(screen, "isDicision", true);
            }
            json.Key("ok").Bool(true);
            json.Key("index").Num(index);
            json.Key("x").Num(x);
            json.Key("y").Num(y);
            json.Key("confirmed").Bool(flagged);
            json.Key("state_before").Describe(stateBefore, 0);
            json.Key("select_tgt").Describe(Reflect.Get(screen, "selectTgt"), 0);
            json.Key("select_x").Describe(Reflect.Get(screen, "selectX"), 0);
            json.Key("select_y").Describe(Reflect.Get(screen, "selectY"), 0);
            // Whether the confirm flag is currently raised. A press that leaks in
            // from the previous screen raises this before anybody picks a name,
            // which is what casts the vote for row 0.
            json.Key("is_dicision").Describe(Reflect.Get(screen, "isDicision"), 0);
            json.Key("textareas").Raw(AllAreaTexts(TextAreaMaps()));
            json.EndObject();
            return json.ToString();
        }

        // Escape hatch: collapse whatever panel is open and drop the cursor. Used
        // when a bad write leaves an empty command window on screen.
        //
        // Hiding the command column is NOT done by clearing select. MyUpdate starts
        // every frame by hiding sprites 1000/1100/1200/1300 and only re-shows them
        // while select >= 0, but the column's TEXT lives in four separate text areas
        // (70925/70971/71015/71057) that nothing resets - the only thing that clears
        // them is the screen's own UnvisibleCommands(). So writing select = -1 hides
        // the panel background and leaves the five command lines floating on screen
        // for the rest of the game, which is exactly the ghost panel that showed up
        // after an advance/pass cycle. Call the game's own method.
        public static string Close()
        {
            Json.Writer json = new Json.Writer();
            json.BeginObject();
            object screen = ActiveInstance("application.InterfaceScreen");
            if (screen == null)
            {
                json.Key("ok").Bool(false);
                json.Key("error").Str("the interface screen is not loaded");
                json.EndObject();
                return json.ToString();
            }
            string cleared;
            try
            {
                MethodInfo hide = screen.GetType().GetMethod("UnvisibleCommands",
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance,
                    null, Type.EmptyTypes, null);
                if (hide == null)
                {
                    cleared = "no UnvisibleCommands on this type";
                }
                else
                {
                    hide.Invoke(screen, null);
                    cleared = "UnvisibleCommands";
                }
            }
            catch (Exception error)
            {
                cleared = "UnvisibleCommands failed: " + error.Message;
            }
            Reflect.Set(screen, "isSpeak", false);
            Reflect.Set(screen, "isData", false);
            Reflect.Set(screen, "isMenu", false);
            Reflect.Set(screen, "isDicision", false);
            Reflect.Set(screen, "isOnPointCommand", false);
            Reflect.Set(screen, "isOnPointAction", false);
            Reflect.Set(screen, "select", -1);
            json.Key("ok").Bool(true);
            json.Key("cleared").Str(cleared);
            json.Key("note").Str("command text cleared the game's own way, flags reset, cursor dropped");
            json.EndObject();
            return json.ToString();
        }

        // The "ROUND n/5" indicator is not a text area - it is a stack of sprites
        // named round_1 .. round_5, and exactly one of them is visible while the
        // player is being asked to act. That makes it both the turn signal and the
        // round number.
        private static void RoundBlock(Json.Writer json, object iface)
        {
            IDictionary map = Reflect.Get(iface, "m_spriteMap") as IDictionary;
            int round = -1;
            int visibleCount = 0;
            json.Key("round_sprites").BeginObject();
            if (map != null)
            {
                foreach (DictionaryEntry entry in map)
                {
                    object sprite = entry.Value;
                    if (sprite == null)
                    {
                        continue;
                    }
                    string name = sprite.ToString();
                    if (!name.StartsWith("round", StringComparison.Ordinal))
                    {
                        continue;
                    }
                    object visibleValue = Reflect.Get(sprite, "m_visible");
                    bool visible = visibleValue is bool && (bool)visibleValue;
                    json.Key(name).Bool(visible);
                    if (!visible)
                    {
                        continue;
                    }
                    visibleCount++;
                }
            }
            json.EndObject();

            // The displayed digit is painted, never named. Map keys 50/60/70 are
            // fixed slots and their names never change - "round_1" sits on screen
            // at 1/5 and at 2/5 alike - so reading the name gave a constant 5
            // (it always ended on round_5, the denominator). Only key 60 moves.
            float glyphV = float.NaN;
            if (visibleCount > 0)
            {
                round = RoundDigitFromSprite(map, out glyphV);
            }
            json.Key("round").Num(round);
            json.Key("round_glyph_v").Str(float.IsNaN(glyphV) ? "unknown" : glyphV.ToString("0.0", System.Globalization.CultureInfo.InvariantCulture));
            json.Key("round_visible_sprites").Num(visibleCount);

            // Calibration data. The three round sprites are fixed slots (map keys
            // 50/60/70) whose *names* never change - "round_1" is on screen at
            // 1/5 and at 2/5 alike. Only the painted texture / atlas rect moves,
            // so the displayed digit has to be read from here, never from the
            // sprite name.
            json.Key("round_detail").BeginArray();
            if (map != null)
            {
                foreach (DictionaryEntry entry in map)
                {
                    object sprite = entry.Value;
                    if (sprite == null)
                    {
                        continue;
                    }
                    string spriteName = sprite.ToString();
                    if (!spriteName.StartsWith("round", StringComparison.Ordinal))
                    {
                        continue;
                    }
                    object visValue = Reflect.Get(sprite, "m_visible");
                    json.BeginObject();
                    json.Key("key").Describe(entry.Key, 0);
                    json.Key("name").Str(spriteName);
                    json.Key("visible").Bool(visValue is bool && (bool)visValue);
                    json.Key("tex").Describe(Reflect.Get(sprite, "m_texture"), 0);
                    json.Key("uv").Describe(Reflect.Get(sprite, "m_textureOffset"), 0);
                    json.Key("tex_size").Describe(Reflect.Get(sprite, "m_sizeInTexture"), 0);
                    json.Key("disp").Describe(Reflect.Get(sprite, "m_displayOffset"), 0);
                    json.EndObject();
                }
            }
            json.EndArray();
        }

        // Dotted path reader with numeric indexing: "chara.3.yaku".
        public static string ReadPath(string typeName, string expr)
        {
            Json.Writer json = new Json.Writer();
            json.BeginObject();
            object root = ActiveInstance(typeName);
            if (root == null)
            {
                root = ActiveInstance("application." + typeName);
            }
            if (root == null)
            {
                root = ActiveInstance("gnosia." + typeName);
            }
            if (root == null)
            {
                json.Key("ok").Bool(false);
                json.Key("error").Str(typeName + " is not loaded right now");
                json.EndObject();
                return json.ToString();
            }
            object current = root;
            string walked = "";
            if (!string.IsNullOrEmpty(expr))
            {
                string[] parts = expr.Split(new char[] { '.' });
                for (int i = 0; i < parts.Length; i++)
                {
                    if (current == null)
                    {
                        break;
                    }
                    string part = parts[i];
                    int index;
                    if (int.TryParse(part, out index))
                    {
                        IList list = current as IList;
                        if (list != null)
                        {
                            current = index >= 0 && index < list.Count ? list[index] : null;
                        }
                        else
                        {
                            Array array = current as Array;
                            current = array != null && index >= 0 && index < array.Length
                                ? array.GetValue(index) : null;
                        }
                    }
                    else
                    {
                        current = Reflect.Get(current, part);
                    }
                    walked += (walked.Length > 0 ? "." : "") + part;
                }
            }
            json.Key("ok").Bool(true);
            json.Key("type").Str(root.GetType().Name);
            json.Key("path").Str(walked);
            json.Key("value_type").Str(current == null ? "null" : current.GetType().Name);
            json.Key("value").Describe(current, 1);
            json.EndObject();
            return json.ToString();
        }

        // Field names of a type, so exploring new data does not need a decompile.
        public static string Fields(string typeName)
        {
            Json.Writer json = new Json.Writer();
            json.BeginObject();
            Type type = Reflect.Find(typeName);
            if (type == null)
            {
                type = Reflect.Find("application." + typeName);
            }
            if (type == null)
            {
                json.Key("ok").Bool(false);
                json.Key("error").Str("no type matching " + typeName);
                json.EndObject();
                return json.ToString();
            }
            json.Key("ok").Bool(true);
            json.Key("type").Str(type.Name);
            json.Key("fields").BeginArray();
            FieldInfo[] fields = type.GetFields(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            for (int i = 0; i < fields.Length; i++)
            {
                json.BeginObject();
                json.Key("name").Str(fields[i].Name);
                json.Key("type").Str(fields[i].FieldType.Name);
                json.EndObject();
            }
            json.EndArray();
            json.EndObject();
            return json.ToString();
        }

        // Follows a dotted path through fields, e.g. "mydata.baseData.takashiAbil".
        // The dump route stops at one level, so nested save data was unreadable.
        private static object Walk(object root, string path)
        {
            if (root == null || string.IsNullOrEmpty(path))
            {
                return null;
            }
            string[] parts = path.Split(new char[] { '.' });
            object current = root;
            for (int i = 0; i < parts.Length; i++)
            {
                if (current == null)
                {
                    return null;
                }
                current = Reflect.Get(current, parts[i]);
            }
            return current;
        }

        private static object AbilHost(out string where)
        {
            where = "";
            object screen = ActiveInstance("application.TakashiSetScreen");
            if (Walk(screen, "mydata.baseData.takashiAbil") is Array)
            {
                where = "TakashiSetScreen";
                return screen;
            }
            object data = ActiveInstance("gnosia.GameData");
            if (Walk(data, "baseData.takashiAbil") is Array)
            {
                where = "GameData";
                return data;
            }
            return null;
        }

        // The creation screen paints the ability column once, in InitializeGlm,
        // and only repaints it from the +/- handler when a value actually
        // changes. Writing baseData.takashiAbil directly therefore left the
        // panel showing the initial 5/5/5/5/5/5 and 剩余点数 5 while the data
        // behind it was already 8/7/5/5/5/5 - the numbers that go into the save
        // were right, the screen lied. Repaint through the screen's own SetText
        // so what the player is about to register is what they see.
        private static void RefreshAbilTexts(object screen, Array abil, int left)
        {
            try
            {
                IDictionary map = Reflect.Get(screen, "m_textAreaMap") as IDictionary;
                if (map == null || abil == null)
                {
                    return;
                }
                MethodInfo setText = screen.GetType().GetMethod("SetText",
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance,
                    null, new Type[] { typeof(string), typeof(string), typeof(bool), typeof(bool) }, null);
                if (setText == null)
                {
                    return;
                }
                if (map.Contains("abil"))
                {
                    StringBuilder text = new StringBuilder();
                    for (int i = 0; i < abil.Length; i++)
                    {
                        if (i > 0)
                        {
                            text.Append('\n');
                        }
                        text.Append(AsNumber(abil.GetValue(i)));
                    }
                    setText.Invoke(screen, new object[] { "abil", text.ToString(), true, true });
                }
                if (map.Contains("abilleft"))
                {
                    setText.Invoke(screen, new object[] { "abilleft", left.ToString(), true, true });
                }
            }
            catch (Exception)
            {
                // A missing key or a changed SetText signature must never turn a
                // successful stat write into an error response.
            }
        }

        private static int TotalOf(Array values)
        {
            int total = 0;
            if (values == null)
            {
                return total;
            }
            for (int i = 0; i < values.Length; i++)
            {
                total += (int)AsNumber(values.GetValue(i));
            }
            return total;
        }

        // The player's six stats, read straight out of the save data.
        public static string ReadAbil()
        {
            Json.Writer json = new Json.Writer();
            json.BeginObject();
            string where;
            object host = AbilHost(out where);
            if (host == null)
            {
                json.Key("ok").Bool(false);
                json.Key("error").Str("no takashiAbil on the creation screen or in GameData");
                json.EndObject();
                return json.ToString();
            }
            bool creation = where == "TakashiSetScreen";
            Array abil = Walk(host, creation ? "mydata.baseData.takashiAbil" : "baseData.takashiAbil") as Array;
            json.Key("ok").Bool(true);
            json.Key("source").Str(where);
            json.Key("values").BeginArray();
            for (int i = 0; i < abil.Length; i++)
            {
                json.Num(AsNumber(abil.GetValue(i)));
            }
            json.EndArray();
            json.Key("total").Num(TotalOf(abil));
            if (creation)
            {
                json.Key("left").Describe(Reflect.Get(host, "abilLeft"), 0);
            }
            json.EndObject();
            return json.ToString();
        }

        // values = "10,5,5,5,5,5"; left defaults to 0.
        //
        // Adding points through the controller is not usable from here: the screen
        // samples IsMenuLeftRight every frame, so a single injected press lands as
        // several +1s, and the same axis also walks the cursor onto the "+1" slot.
        // Writing the array the screen edits is the only deterministic way.
        public static string SetAbil(string values, string left)
        {
            Json.Writer json = new Json.Writer();
            json.BeginObject();
            string where;
            object host = AbilHost(out where);
            if (host == null)
            {
                json.Key("ok").Bool(false);
                json.Key("error").Str("no takashiAbil on the creation screen or in GameData");
                json.EndObject();
                return json.ToString();
            }
            bool creation = where == "TakashiSetScreen";
            Array abil = Walk(host, creation ? "mydata.baseData.takashiAbil" : "baseData.takashiAbil") as Array;
            int before = TotalOf(abil);
            if (!string.IsNullOrEmpty(values))
            {
                string[] parts = values.Split(new char[] { ',' });
                for (int i = 0; i < parts.Length && i < abil.Length; i++)
                {
                    int value;
                    if (!int.TryParse(parts[i].Trim(), out value))
                    {
                        continue;
                    }
                    if (value < 1)
                    {
                        value = 1;
                    }
                    if (value > 20)
                    {
                        value = 20;
                    }
                    abil.SetValue(Convert.ChangeType(value, abil.GetValue(i).GetType()), i);
                }
            }
            int leftValue = 0;
            if (left != null && int.TryParse(left, out leftValue) && creation)
            {
                Reflect.Set(host, "abilLeft", leftValue);
            }
            if (creation)
            {
                Reflect.Call(host, "Render");
                RefreshAbilTexts(host, abil, (int)AsNumber(Reflect.Get(host, "abilLeft")));
            }
            json.Key("ok").Bool(true);
            json.Key("source").Str(where);
            json.Key("before_total").Num(before);
            json.Key("after_total").Num(TotalOf(abil));
            json.Key("values").BeginArray();
            for (int i = 0; i < abil.Length; i++)
            {
                json.Num(AsNumber(abil.GetValue(i)));
            }
            json.EndArray();
            if (creation)
            {
                json.Key("left").Describe(Reflect.Get(host, "abilLeft"), 0);
            }
            json.EndObject();
            return json.ToString();
        }

        // Where the game actually keeps its files.
        //
        // The save folder is not under AppData\LocalLow\<Company>\<Product> for this
        // build, and there is no path field on GameData, so ask Unity instead of
        // guessing - persistentDataPath is the one directory that is certain.
        public static string Env()
        {
            Json.Writer json = new Json.Writer();
            json.BeginObject();
            Type app = Reflect.Find("UnityEngine.Application");
            string persistent = null;
            string dataPath = null;
            string version = null;
            if (app != null)
            {
                try
                {
                    PropertyInfo p = app.GetProperty("persistentDataPath", BindingFlags.Public | BindingFlags.Static);
                    if (p != null)
                    {
                        persistent = p.GetValue(null, null) as string;
                    }
                    PropertyInfo d = app.GetProperty("dataPath", BindingFlags.Public | BindingFlags.Static);
                    if (d != null)
                    {
                        dataPath = d.GetValue(null, null) as string;
                    }
                    PropertyInfo v = app.GetProperty("unityVersion", BindingFlags.Public | BindingFlags.Static);
                    if (v != null)
                    {
                        version = v.GetValue(null, null) as string;
                    }
                }
                catch
                {
                    // properties are best effort
                }
            }
            json.Key("ok").Bool(!string.IsNullOrEmpty(persistent));
            json.Key("persistent_data_path").Str(persistent ?? "");
            json.Key("data_path").Str(dataPath ?? "");
            json.Key("unity").Str(version ?? "");
            json.EndObject();
            return json.ToString();
        }

        // Puts text into a screen's input box through the component's own setter.
        //
        // Reflection on the backing field would skip onValueChanged, and the screen
        // reads its state from that callback; going through the "text" property is
        // the same path a paste takes inside the game.
        public static string SetInput(string screenName, string value)
        {
            Json.Writer json = new Json.Writer();
            json.BeginObject();
            string full = screenName.IndexOf('.') >= 0 ? screenName : "application." + screenName;
            object screen = ActiveInstance(full);
            if (screen == null)
            {
                json.Key("ok").Bool(false);
                json.Key("error").Str(full + " is not on screen right now");
                json.EndObject();
                return json.ToString();
            }
            const BindingFlags flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;
            Type type = screen.GetType();
            object input = null;
            string fieldName = null;
            Type inputType = null;
            FieldInfo[] fields = type.GetFields(flags);
            for (int i = 0; i < fields.Length; i++)
            {
                string typeName = fields[i].FieldType.Name;
                if (typeName != "InputField" && typeName != "TMP_InputField")
                {
                    continue;
                }
                object candidate = fields[i].GetValue(screen);
                if (candidate == null)
                {
                    continue;
                }
                input = candidate;
                fieldName = fields[i].Name;
                inputType = fields[i].FieldType;
                break;
            }
            if (input == null)
            {
                json.Key("ok").Bool(false);
                json.Key("error").Str("no InputField/TMP_InputField on " + type.Name);
                json.EndObject();
                return json.ToString();
            }
            string before = null;
            try
            {
                PropertyInfo textProperty = inputType.GetProperty("text", flags);
                if (textProperty == null)
                {
                    json.Key("ok").Bool(false);
                    json.Key("error").Str("the input has no text property");
                    json.EndObject();
                    return json.ToString();
                }
                before = textProperty.GetValue(input, null) as string;
                if (value != null)
                {
                    textProperty.SetValue(input, value, null);
                }
            }
            catch (Exception error)
            {
                json.Key("ok").Bool(false);
                json.Key("error").Str(error.Message);
                json.EndObject();
                return json.ToString();
            }
            // Some screens only pick the value up on deselect.
            if (value != null)
            {
                Reflect.Call(screen, "InputFieldDeselect", value);
            }
            json.Key("ok").Bool(true);
            json.Key("screen").Str(type.Name);
            json.Key("field").Str(fieldName);
            json.Key("before").Str(before ?? "");
            json.Key("after").Str(value ?? "");
            json.EndObject();
            return json.ToString();
        }

        // A method with no parameters, or exactly one string parameter.
        //
        // The click route only matches (int), which is why screens whose confirm is
        // an argument-less handler (TakashiSetScreen.EnterSelect, the help screen's
        // EnterSelectLv2) could not be driven at all before.
        public static string CallNoArg(string screenName, string method, string arg)
        {
            Json.Writer json = new Json.Writer();
            json.BeginObject();
            string full = screenName.IndexOf('.') >= 0 ? screenName : "application." + screenName;
            object screen = ActiveInstance(full);
            if (screen == null)
            {
                json.Key("ok").Bool(false);
                json.Key("error").Str(full + " is not on screen right now");
                json.EndObject();
                return json.ToString();
            }
            Type type = screen.GetType();
            const BindingFlags flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;
            MethodInfo target = null;
            object[] callArgs = new object[0];
            if (!string.IsNullOrEmpty(arg))
            {
                target = type.GetMethod(method, flags, null, new Type[] { typeof(string) }, null);
                if (target != null)
                {
                    callArgs = new object[] { arg };
                }
            }
            if (target == null)
            {
                target = type.GetMethod(method, flags, null, Type.EmptyTypes, null);
                callArgs = new object[0];
            }
            if (target == null)
            {
                json.Key("ok").Bool(false);
                json.Key("error").Str("no " + method + "() or " + method + "(string) on " + type.Name);
                json.EndObject();
                return json.ToString();
            }
            Reflect.Set(screen, "isMouseEnable", true);
            object result = target.Invoke(screen, callArgs);
            json.Key("ok").Bool(true);
            json.Key("screen").Str(type.Name);
            json.Key("method").Str(method);
            json.Key("args").Num(callArgs.Length);
            json.Key("result").Describe(result, 0);
            json.EndObject();
            return json.ToString();
        }

        // Writes the 初期条件設定 numbers and lets the screen rebuild its own view.
        //
        // The screen's click handler can only add to a role and only subtract from
        // 人数 (delta = selectTgt % 10 == 0 ? -1 : +1), so a target like
        // "12人 / 4古诺希亚 / 留舰者=0" is unreachable by clicking: every role
        // count would only ever grow. Writing yakuNum directly, then calling the
        // screen's own CountMura/SetButtons/ChangeNum, keeps the 乘客 remainder and
        // the numbers on screen in sync with the data the loop will actually use.
        public static string Setup(string peopleRaw, string gnosiaRaw, string rolesRaw, string selfRaw)
        {
            Json.Writer json = new Json.Writer();
            json.BeginObject();
            object screen = ActiveInstance("application.MakeLoopScreen");
            if (screen == null)
            {
                json.Key("ok").Bool(false);
                json.Key("error").Str("the 初期条件設定 screen is not on screen right now");
                json.EndObject();
                return json.ToString();
            }
            Array yakuNum = Reflect.Get(screen, "yakuNum") as Array;
            if (yakuNum == null)
            {
                json.Key("ok").Bool(false);
                json.Key("error").Str("yakuNum is missing");
                json.EndObject();
                return json.ToString();
            }

            int value;
            if (peopleRaw != null && int.TryParse(peopleRaw, out value))
            {
                Reflect.Set(screen, "people", value);
            }
            if (gnosiaRaw != null && int.TryParse(gnosiaRaw, out value) && yakuNum.Length > 7)
            {
                yakuNum.SetValue(value, 7);
            }
            if (!string.IsNullOrEmpty(rolesRaw))
            {
                string[] parts = rolesRaw.Split(new char[] { ',' });
                for (int i = 0; i < parts.Length && i < yakuNum.Length; i++)
                {
                    int roleCount;
                    if (int.TryParse(parts[i].Trim(), out roleCount))
                    {
                        yakuNum.SetValue(roleCount, i);
                    }
                }
            }
            if (selfRaw != null && int.TryParse(selfRaw, out value))
            {
                Reflect.Set(screen, "shujinkoYaku", value);
            }

            Reflect.Call(screen, "CountMura");
            Reflect.Call(screen, "SetButtons");
            Reflect.Call(screen, "ChangeNum");

            Array after = Reflect.Get(screen, "yakuNum") as Array;
            json.Key("ok").Bool(true);
            json.Key("people").Describe(Reflect.Get(screen, "people"), 0);
            json.Key("shujinko").Describe(Reflect.Get(screen, "shujinkoYaku"), 0);
            json.Key("yakuNum").BeginArray();
            if (after != null)
            {
                for (int i = 0; i < after.Length; i++)
                {
                    json.Num(AsNumber(after.GetValue(i)));
                }
            }
            json.EndArray();
            json.EndObject();
            return json.ToString();
        }

        // Atlas v of the numerator glyph for each formal round, measured live:
        //   1 -> 354, 2 -> 454, 3 -> 293, 4 -> 179, 5 -> 232
        // The five digits are packed in arbitrary order (4 lives at u 465 while
        // the rest share u 152/153), so this can only be a lookup table - never
        // arithmetic on the value. v is unique per digit, which is what makes the
        // match below exact; u drifts by a pixel between frames (2/5 read 152 and
        // 153 in the same run), so it is deliberately not compared.
        private static readonly int[] RoundGlyphV = { 354, 454, 293, 179, 232 };

        private static int RoundDigitFromSprite(IDictionary map, out float glyphV)
        {
            glyphV = float.NaN;
            object sprite = FindSprite(map, 60);
            if (sprite == null)
            {
                return -1;
            }
            object offset = Reflect.Get(sprite, "m_textureOffset");
            glyphV = Component(offset, "y");
            if (float.IsNaN(glyphV))
            {
                return -1;
            }
            for (int i = 0; i < RoundGlyphV.Length; i++)
            {
                if (Math.Abs(glyphV - RoundGlyphV[i]) <= 2f)
                {
                    return i + 1;
                }
            }
            // A glyph that is not in the table (new day, different bitmap) must not
            // be guessed: -1 tells the caller "unknown" instead of a wrong number.
            return -1;
        }

        private static float Component(object vector, string field)
        {
            object raw = Reflect.Get(vector, field);
            if (raw is float)
            {
                return (float)raw;
            }
            if (raw is double)
            {
                return (float)(double)raw;
            }
            if (raw is int)
            {
                return (int)raw;
            }
            return float.NaN;
        }

        // Sprite lookup by the fixed map key (50 = ROUND, 60 = digit, 70 = "/5",
        // 1000..1300 = the four corner buttons).
        //
        // The map's key type is NOT int: Describe() renders the keys as JSON
        // strings ("50", "60", "1000"), so the old `map.Contains(60)` / `map[60]`
        // never matched anything. That is also why buttons.speak stayed false while
        // 发言 was plainly on screen. Compare by value instead, whatever the key is
        // boxed as.
        private static object FindSprite(IDictionary map, int wanted)
        {
            if (map == null)
            {
                return null;
            }
            foreach (DictionaryEntry entry in map)
            {
                if (entry.Key == null || entry.Value == null)
                {
                    continue;
                }
                int key;
                if (entry.Key is int)
                {
                    key = (int)entry.Key;
                }
                else if (!int.TryParse(Convert.ToString(entry.Key), out key))
                {
                    continue;
                }
                if (key == wanted)
                {
                    return entry.Value;
                }
            }
            return null;
        }

        private static bool VisibleByKey(IDictionary map, int key)
        {
            object sprite = FindSprite(map, key);
            if (sprite == null)
            {
                return false;
            }
            object visible = Reflect.Get(sprite, "m_visible");
            return visible is bool && (bool)visible;
        }

        // The command rows come from text areas (com_L / com_R), but the identity
        // of each command lives in GameData.actions - an id that is language
        // independent. Exposing the ids lets callers tell a 报告 (report) round
        // apart from an ordinary accusation without matching UI strings.
        private static void ActionBlock(Json.Writer json, object iface)
        {
            object gd = Reflect.Get(iface, "mydata");
            IList acts = gd == null ? null : Reflect.Get(gd, "actions") as IList;
            json.Key("actions").BeginArray();
            if (acts != null)
            {
                for (int i = 0; i < acts.Count; i++)
                {
                    object a = acts[i];
                    if (a == null)
                    {
                        continue;
                    }
                    json.BeginObject();
                    json.Key("i").Num(i);
                    json.Key("id").Describe(Reflect.Get(a, "id"), 0);
                    json.Key("type").Describe(Reflect.Get(a, "type"), 0);
                    json.Key("scenario").Describe(Reflect.Get(a, "scenarioNum"), 0);
                    json.Key("mainP").Describe(Reflect.Get(a, "mainP"), 0);
                    json.Key("targetP").Describe(Reflect.Get(a, "targetP"), 0);
                    json.EndObject();
                }
            }
            json.EndArray();
            IList sel = gd == null ? null : Reflect.Get(gd, "actionsCanSelect") as IList;
            json.Key("actions_can_select").BeginArray();
            if (sel != null)
            {
                for (int i = 0; i < sel.Count; i++)
                {
                    json.Num(AsNumber(sel[i]));
                }
            }
            json.EndArray();
        }

        private static List<string> TextAreaKeys(object screen)
        {
            List<string> keys = new List<string>();
            IDictionary map = Reflect.Get(screen, "m_textAreaMap") as IDictionary;
            if (map == null)
            {
                return keys;
            }
            string[] wanted = new string[] { "day", "mainname", "role", "command", "com_Name", "mes", "title", "slot" };
            foreach (DictionaryEntry entry in map)
            {
                string key = Convert.ToString(entry.Key);
                for (int i = 0; i < wanted.Length; i++)
                {
                    if (key == wanted[i] || key.StartsWith(wanted[i], StringComparison.OrdinalIgnoreCase))
                    {
                        keys.Add(key);
                        break;
                    }
                }
            }
            return keys;
        }

        private static double AsNumber(object value)
        {
            try
            {
                return value == null ? -1 : Convert.ToDouble(value);
            }
            catch (Exception)
            {
                return -1;
            }
        }

        // Compact "a,b,c" rendering of selectPos / selectNum, for diagnostics
        // only. Describe() prints the array type name, which hides the numbers we
        // actually want to see when a cursor refuses to move.
        private static string IntList(object value)
        {
            IList list = value as IList;
            if (list == null)
            {
                return "";
            }
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < list.Count; i++)
            {
                if (i > 0)
                {
                    sb.Append(',');
                }
                sb.Append(AsNumber(list[i]));
            }
            return sb.ToString();
        }

        // Every screen class in this game follows the same shape:
        //   selectTgt   the cursor row
        //   selectMax   how many rows exist
        //   isDicision  "the player confirmed" flag, consumed by MyUpdate
        // TitleScreen swaps isDicision for enterSelect. So one generic driver
        // covers title, save slots, the room menu, voting and the data panels -
        // no screen needs its own mouse coordinates.
        public static string Ui(string screenName, int index, bool confirm, bool navigate)
        {
            Json.Writer json = new Json.Writer();
            json.BeginObject();
            string full = screenName.IndexOf('.') >= 0 ? screenName : "application." + screenName;
            object screen = ActiveInstance(full);
            if (screen == null)
            {
                json.Key("ok").Bool(false);
                json.Key("error").Str(full + " is not on screen right now");
                json.EndObject();
                return json.ToString();
            }

            Type type = screen.GetType();
            const BindingFlags flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;
            Reflect.Set(screen, "isMouseEnable", true);

            string cursorField = null;
            if (type.GetField("selectTgt", flags) != null)
            {
                cursorField = "selectTgt";
            }
            else if (type.GetField("select", flags) != null)
            {
                cursorField = "select";
            }

            // YesNoDialogScreen has no cursor at all: it carries two one-shot
            // flags, isYes / isNo, which MyUpdate consumes after a 0.3s guard.
            // EnterActionButton there is gated on Input.GetMouseButtonDown(0),
            // so a real click was the only way to answer before this. Index 0
            // is 是, index 1 is 否.
            bool yesNoScreen = type.GetField("isYes", flags) != null
                && type.GetField("isNo", flags) != null;

            bool moved = false;
            string movedBy = "none";
            if (navigate)
            {
                if (yesNoScreen)
                {
                    // PointerEnter only reveals the 是/否 button; it does not answer.
                    if (index >= 0 && index <= 1)
                    {
                        Reflect.Call(screen, "PointerEnter", index);
                        moved = true;
                        movedBy = "PointerEnter(YesNo)";
                    }
                }
                else
                {
                    // Prefer the screen's own mover: it also repositions sprites and
                    // keeps selectState/selectY in sync, exactly like a mouse hover.
                    MethodInfo mover = type.GetMethod("SelectTarget", flags, null, new Type[] { typeof(int) }, null);
                    if (mover != null)
                    {
                        mover.Invoke(screen, new object[] { index });
                        moved = true;
                        movedBy = "SelectTarget";
                    }
                    else if (type.GetField("selectX", flags) != null && type.GetField("selectY", flags) != null)
                    {
                        // Two-axis screens (VoteScreen and friends) pack the cursor as
                        // selectTgt = selectX * 6 + selectY. Writing selectTgt alone
                        // changed the outcome but left the cursor sprite on the old
                        // person, which is exactly the bug we just fixed on the
                        // command list.
                        MethodInfo mover2 = type.GetMethod("SelectTarget", flags, null, new Type[] { typeof(int), typeof(int) }, null);
                        if (mover2 != null)
                        {
                            // VoteScreen/SelectTgtScreen pack x*6+y (a literal 6);
                            // DataJoinSelScreen packs x*maxY+y. Read maxY when the
                            // screen has it instead of assuming 6 everywhere.
                            int cols = 6;
                            int maxY = (int)AsNumber(Reflect.Get(screen, "maxY"));
                            if (maxY > 0)
                            {
                                cols = maxY;
                            }
                            int x = index / cols;
                            int y = index % cols;
                            mover2.Invoke(screen, new object[] { x, y });
                            moved = true;
                            movedBy = "SelectTarget(x,y)";
                        }
                    }
                    if (!moved)
                    {
                        // A few panels name their mover differently. Try the known
                        // variants before falling back to writing the cursor field,
                        // because a raw field write does not redraw the highlight.
                        string[] altMovers = new string[]
                        {
                            "SelectTargetCursor", "SelectButton", "SelectTargetColorBar",
                            "SelectTargetTitle", "SelectEventBtn", "SelectLv1"
                        };
                        for (int i = 0; i < altMovers.Length; i++)
                        {
                            MethodInfo alt = type.GetMethod(altMovers[i], flags, null, new Type[] { typeof(int) }, null);
                            if (alt == null)
                            {
                                continue;
                            }
                            alt.Invoke(screen, new object[] { index });
                            moved = true;
                            movedBy = altMovers[i];
                            break;
                        }
                    }
                    if (!moved && cursorField != null)
                    {
                        moved = Reflect.Set(screen, cursorField, index);
                        movedBy = cursorField;
                    }
                    Array pos = Reflect.Get(screen, "selectPos") as Array;
                    if (pos != null && index >= 0 && index < pos.Length)
                    {
                        pos.SetValue(0, index);
                    }
                }
            }

            bool flagged = false;
            if (confirm)
            {
                // Reset first: a flag left true by an earlier call wedges the
                // screen, because MyUpdate keeps taking the confirm branch.
                if (yesNoScreen)
                {
                    string flagName = index == 1 ? "isNo" : "isYes";
                    Reflect.Set(screen, flagName, false);
                    flagged = Reflect.Set(screen, flagName, true);
                }
                else
                {
                    if (type.GetField("isDicision", flags) != null)
                    {
                        Reflect.Set(screen, "isDicision", false);
                        flagged = Reflect.Set(screen, "isDicision", true);
                    }
                    if (type.GetField("enterSelect", flags) != null)
                    {
                        flagged = Reflect.Set(screen, "enterSelect", true);
                    }
                }
            }

            json.Key("ok").Bool(true);
            json.Key("screen").Str(type.Name);
            json.Key("index").Num(index);
            json.Key("moved").Bool(moved);
            json.Key("moved_by").Str(movedBy);
            json.Key("confirmed").Bool(flagged);
            json.Key("yes_no").Bool(yesNoScreen);
            json.Key("select_now").Describe(Reflect.Get(screen, cursorField ?? "selectTgt"), 0);
            json.Key("select_max").Describe(Reflect.Get(screen, "selectMax"), 0);
            if (yesNoScreen)
            {
                json.Key("is_yes").Describe(Reflect.Get(screen, "isYes"), 0);
                json.Key("is_no").Describe(Reflect.Get(screen, "isNo"), 0);
                json.Key("can_select").Describe(Reflect.Get(screen, "m_canSelect"), 0);
            }
            json.Key("textareas").Raw(AllAreaTexts(TextAreaMaps()));
            json.EndObject();
            return json.ToString();
        }

        // Several screen types have more than one live instance (prefabs, faded
        // copies). Take the one the game is actually showing.
        private static object ActiveInstance(string fullName)
        {
            Type type = Reflect.Find(fullName);
            if (type == null)
            {
                return null;
            }
            UnityEngine.Object[] objects = Resources.FindObjectsOfTypeAll(type);
            if (objects == null || objects.Length == 0)
            {
                return null;
            }
            object fallback = null;
            for (int i = 0; i < objects.Length; i++)
            {
                object candidate = objects[i];
                if (candidate == null)
                {
                    continue;
                }
                if (fallback == null)
                {
                    fallback = candidate;
                }
                object state = Reflect.Get(candidate, "m_state");
                if (state != null && string.Equals(state.ToString(), "show", StringComparison.OrdinalIgnoreCase))
                {
                    return candidate;
                }
            }
            return fallback;
        }

        private static string MapView(object move)
        {
            Json.Writer json = new Json.Writer();
            json.BeginObject();
            IList selectList = Reflect.Get(move, "selectList") as IList;
            IList placeDesc = Reflect.Get(move, "placeDesc") as IList;
            IList placeXY = Reflect.Get(move, "placeXY") as IList;

            json.Key("cursor").BeginObject();
            json.Key("place").Describe(Safe(delegate { return Reflect.Get(move, "selectTgt"); }), 1);
            json.Key("index").Describe(Safe(delegate { return Reflect.Get(move, "selectX"); }), 1);
            json.EndObject();

            json.Key("places").BeginArray();
            if (selectList != null)
            {
                for (int i = 0; i < selectList.Count; i++)
                {
                    int place = 0;
                    try
                    {
                        place = Convert.ToInt32(selectList[i]);
                    }
                    catch
                    {
                        place = -1;
                    }
                    json.BeginObject();
                    json.Key("place").Num(place);
                    json.Key("index").Num(i);
                    json.Key("desc").Str(Cut(AtIndex(placeDesc, place), 160));
                    json.Key("xy").Str(AtIndex(placeXY, place));
                    json.EndObject();
                }
            }
            json.EndArray();
            json.EndObject();
            return json.ToString();
        }

        private static string AtIndex(IList list, int index)
        {
            if (list == null || index < 0 || index >= list.Count || list[index] == null)
            {
                return null;
            }
            return list[index].ToString();
        }

        private static string Cut(string text, int max)
        {
            if (string.IsNullOrEmpty(text))
            {
                return null;
            }
            string flat = text.Replace('\n', ' ').Trim();
            return flat.Length <= max ? flat : flat.Substring(0, max) + "...";
        }

        public static string Field(string typeName, string fieldName)
        {
            Json.Writer json = new Json.Writer();
            json.BeginObject();
            Type type = Reflect.Find(typeName);
            json.Key("ok").Bool(type != null);
            json.Key("type").Str(typeName);
            json.Key("field").Str(fieldName);
            if (type == null)
            {
                json.Key("error").Str("type not found");
                json.EndObject();
                return json.ToString();
            }
            object value = Reflect.Static(type, fieldName);
            json.Key("value_type").Str(Reflect.TypeName(value));
            json.Key("value").Describe(value, 3);
            json.EndObject();
            return json.ToString();
        }

        private static string TextAreaProbe()
        {
            Json.Writer json = new Json.Writer();
            Type areaType = Reflect.Find("coreSystem.TextArea");
            if (areaType == null)
            {
                return "{\"error\":\"coreSystem.TextArea not found\"}";
            }
            UnityEngine.Object[] areas = Resources.FindObjectsOfTypeAll(areaType);
            json.BeginObject();
            json.Key("count").Num(areas == null ? 0 : areas.Length);
            json.Key("items").BeginArray();
            int limit = areas == null ? 0 : Math.Min(areas.Length, 4);
            for (int i = 0; i < limit; i++)
            {
                object area = areas[i];
                json.BeginObject();
                try
                {
                    json.Key("name").Str(areas[i].name);
                    json.Key("visible").Describe(Safe(delegate { return Reflect.Get(area, "visible"); }), 1);
                    json.Key("finished").Describe(Safe(delegate { return Reflect.Call(area, "Finished"); }), 1);
                    json.Key("now_line").Describe(Safe(delegate { return Reflect.Get(area, "nowLine"); }), 1);
                    json.Key("max_line").Describe(Safe(delegate { return Reflect.Get(area, "maxLine"); }), 1);
                    json.Key("str_now").Describe(Safe(delegate { return Reflect.Get(area, "strNowList"); }), 2);
                    json.Key("str_list").Describe(Safe(delegate { return Reflect.Get(area, "strList"); }), 2);
                }
                catch (Exception error)
                {
                    json.Key("error").Str(error.GetType().Name + ": " + error.Message);
                }
                json.EndObject();
            }
            json.EndArray();
            json.EndObject();
            return json.ToString();
        }

        private static string MessageLogProbe()
        {
            Type logType = Reflect.Find("application.MessageLog");
            if (logType == null)
            {
                return "{\"error\":\"application.MessageLog not found\"}";
            }
            Json.Writer json = new Json.Writer();
            json.BeginObject();
            json.Key("name_now").Describe(Safe(delegate { return Reflect.Static(logType, "mesLogName_now"); }), 1);
            json.Key("text_now").Describe(Safe(delegate { return Reflect.Static(logType, "mesLogText_now"); }), 1);
            json.Key("dialog_now").Describe(Safe(delegate { return Reflect.Static(logType, "mesLogDialog_now"); }), 1);
            json.Key("text").Describe(Safe(delegate { return Reflect.Static(logType, "mesLogText"); }), 1);
            json.EndObject();
            return json.ToString();
        }
    }

    // ----------------------------------------------------------------- json

    internal static class Json
    {
        public static string Quote(string value)
        {
            if (value == null)
            {
                return "null";
            }
            StringBuilder sb = new StringBuilder(value.Length + 8);
            sb.Append('"');
            for (int i = 0; i < value.Length; i++)
            {
                char c = value[i];
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20 || c == 0x7f)
                        {
                            sb.Append("\\u").Append(((int)c).ToString("x4"));
                        }
                        else
                        {
                            sb.Append(c);
                        }
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }

        internal sealed class Writer
        {
            private readonly StringBuilder _sb = new StringBuilder(4096);
            private bool _needComma;
            private string _pendingKey;

            private void Prefix()
            {
                if (_pendingKey != null)
                {
                    if (_needComma)
                    {
                        _sb.Append(',');
                    }
                    _sb.Append(Quote(_pendingKey)).Append(':');
                    _pendingKey = null;
                    _needComma = false;
                    return;
                }
                if (_needComma)
                {
                    _sb.Append(',');
                }
                _needComma = false;
            }

            public Writer Key(string key)
            {
                _pendingKey = key;
                return this;
            }

            public Writer Raw(string raw)
            {
                Prefix();
                _sb.Append(string.IsNullOrEmpty(raw) ? "null" : raw);
                _needComma = true;
                return this;
            }

            public Writer Str(string value)
            {
                Prefix();
                _sb.Append(Quote(value));
                _needComma = true;
                return this;
            }

            public Writer Bool(bool value)
            {
                Prefix();
                _sb.Append(value ? "true" : "false");
                _needComma = true;
                return this;
            }

            public Writer Num(double value)
            {
                Prefix();
                _sb.Append(value.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture));
                _needComma = true;
                return this;
            }

            public Writer BeginObject()
            {
                Prefix();
                _sb.Append('{');
                _needComma = false;
                return this;
            }

            public Writer EndObject()
            {
                _sb.Append('}');
                _needComma = true;
                return this;
            }

            public Writer BeginArray()
            {
                Prefix();
                _sb.Append('[');
                _needComma = false;
                return this;
            }

            public Writer EndArray()
            {
                _sb.Append(']');
                _needComma = true;
                return this;
            }

            // Tolerant value writer: the whole point of v0.1 is discovering the
            // real types, so unknown shapes are reported rather than thrown.
            public Writer Describe(object value, int depth)
            {
                if (value == null)
                {
                    return Raw("null");
                }
                string text = value as string;
                if (text != null)
                {
                    return Str(text.Length > 2000 ? text.Substring(0, 2000) + "..." : text);
                }
                if (value is bool)
                {
                    return Bool((bool)value);
                }
                if (value is int || value is long || value is short || value is byte)
                {
                    return Num(Convert.ToDouble(value));
                }
                if (value is float || value is double || value is decimal)
                {
                    return Num(Convert.ToDouble(value));
                }
                if (value is Enum)
                {
                    return Str(value.ToString());
                }

                IEnumerable sequence = value as IEnumerable;
                if (sequence != null && depth > 0)
                {
                    BeginArray();
                    int count = 0;
                    foreach (object item in sequence)
                    {
                        if (count++ >= 40)
                        {
                            break;
                        }
                        Describe(item, depth - 1);
                    }
                    EndArray();
                    return this;
                }

                // Plain game objects (nissiData, actionData, Person...) are useless
                // as ToString(), so expand their fields one level when depth allows.
                if (depth > 0 && !(value is Type) && !(value is Delegate))
                {
                    Type objectType = value.GetType();
                    if (!typeof(UnityEngine.Object).IsAssignableFrom(objectType))
                    {
                        FieldInfo[] fields = objectType.GetFields(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
                        if (fields.Length > 0 && fields.Length <= 64)
                        {
                            BeginObject();
                            int emitted = 0;
                            for (int i = 0; i < fields.Length && emitted < 24; i++, emitted++)
                            {
                                object fieldValue = null;
                                string fieldError = null;
                                try
                                {
                                    fieldValue = fields[i].GetValue(value);
                                }
                                catch (Exception error)
                                {
                                    fieldError = error.GetType().Name;
                                }
                                Key(fields[i].Name);
                                if (fieldError != null)
                                {
                                    Str("ERROR " + fieldError);
                                }
                                else
                                {
                                    Describe(fieldValue, depth - 1);
                                }
                            }
                            EndObject();
                            return this;
                        }
                    }
                }

                string plain = value.ToString();
                if (plain.Length > 400)
                {
                    plain = plain.Substring(0, 400) + "...";
                }
                return Str(plain);
            }

            public override string ToString()
            {
                return _sb.ToString();
            }
        }
    }
}
