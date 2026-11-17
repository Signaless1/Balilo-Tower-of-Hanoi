:- module(web_server, [main/0, start_server/1, stop_server/0]).

:- use_module(library(http/thread_httpd)).
:- use_module(library(http/http_dispatch)).
:- use_module(library(http/http_json)).
:- use_module(library(http/http_files)).
:- use_module(hanoi_core).

:- dynamic server_port/1.

:- http_handler(root(api), api_handler, [prefix]).
:- http_handler(root(.), static_handler, [prefix]).

/* Serve the browser client from the sibling web/ directory. */
project_web_dir(Dir) :-
    source_file(web_server:main, File),
    file_directory_name(File, PrologDir),
    directory_file_path(PrologDir, '../web', RawDir),
    absolute_file_name(RawDir, Dir, [file_type(directory)]).

static_handler(Request) :-
    project_web_dir(WebDir),
    http_reply_from_files(WebDir, [indexes(['index.html'])], Request).

api_handler(Request) :-
    ( memberchk(method(post), Request) ->
        catch(read_and_dispatch(Request, Response0), Error,
              ( print_message(error, Error),
                message_to_string(Error, Message),
                Response0 = _{error:Message} )),
        ( get_dict(error, Response0, _) ->
            reply_json_dict(Response0, [status(500)])
        ;   reply_json_dict(Response0)
        )
    ;   reply_json_dict(_{error:"POST JSON requests only."}, [status(405)])
    ).

read_and_dispatch(Request, Response) :-
    http_read_json_dict(Request, Payload),
    ( hanoi_core:dispatch(Payload, Response0) -> Response = Response0
    ; Response = _{error:"The Prolog operation could not be completed."}
    ).

start_server(Port) :-
    ( server_port(_) -> stop_server ; true ),
    http_server(http_dispatch, [port(Port), ip('127.0.0.1'), workers(16)]),
    asserta(server_port(Port)),
    format(user_error, 'Tower of Hanoi: Beyond Infinity is available at http://localhost:~d/~n', [Port]).

stop_server :-
    ( retract(server_port(Port)) -> http_stop_server(Port, []) ; true ).

main :-
    ( getenv('PORT', PortText),
      ( atom(PortText) -> catch(atom_number(PortText, Port), _, fail)
      ; catch(number_string(Port, PortText), _, fail) ),
      integer(Port), Port > 0, Port < 65536 -> true
    ; Port = 8080
    ),
    start_server(Port),
    thread_get_message(stop).

:- initialization(main, main).
