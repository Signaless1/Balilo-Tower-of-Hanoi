:- module(hanoi_core, [dispatch/2]).

:- use_module(library(assoc)).
:- use_module(library(lists)).
:- use_module(library(apply)).
:- use_module(library(aggregate)).
:- dynamic distance_cache/3.
:- table frame_stewart/3.

/*
 * Tower of Hanoi domain logic.
 * All move rules, solver searches, optimality calculations and score formulas
 * are evaluated here.  The browser client is the presentation layer.
 */

dispatch(Request, Response) :-
    get_dict(op, Request, OpValue),
    operation_atom(OpValue, Op),
    dispatch_op(Op, Request, Response).

/* JSON readers may represent a JSON string as a SWI string or an atom,
   depending on the reader options/version. Accept either representation. */
operation_atom(Value, Op) :-
    (   atom(Value)
    ->  Op = Value
    ;   string(Value)
    ->  atom_string(Op, Value)
    ;   throw(error(type_error(atom_or_string, Value),
                    context(hanoi_core:dispatch/2, 'Expected a JSON operation name')))
    ).

/* -- public protocol ----------------------------------------------------- */

dispatch_op(ping, _, _{pong: true}).

dispatch_op(validate_rules, Req, _{valid: true}) :-
    rules_from_dict(Req, Rules),
    get_dict(initial_positions, Req, Initial),
    Rules = rules(T,N,_,Restrictions,Limit,Target),
    valid_position(Initial,T,N), valid_position(Target,T,N),
    ( Limit = none ; integer(Limit), Limit > 0 ),
    target_restrictions_valid(Target, Restrictions).

dispatch_op(validate_move, Req, _{reason:Reason, disk:Disk}) :-
    move_request(Req, Rules, Pos, Moves, Locked, DynamicClosed,
                 Src, Dst, Teleport),
    move_check(Rules, Pos, Moves, Locked, DynamicClosed,
               Src, Dst, Teleport, Reason, Disk).

dispatch_op(apply_move, Req, Response) :-
    move_request(Req, Rules, Pos, Moves, Locked, DynamicClosed,
                 Src, Dst, Teleport),
    move_check(Rules, Pos, Moves, Locked, DynamicClosed,
               Src, Dst, Teleport, Reason, Disk),
    ( Reason == none ->
        Index is Disk-1,
        set_nth0(Index, Pos, Dst, NewPos),
        Response = _{ok: true, reason:"", disk:Disk, pos:NewPos}
    ; Response = _{ok: false, reason:Reason, disk:Disk, pos:Pos}
    ).

dispatch_op(legal_moves, Req, _{moves:Moves}) :-
    rules_from_dict(Req, Rules),
    get_dict(pos, Req, Pos),
    get_dict(moves_used, Req, MovesUsed),
    get_dict(teleport, Req, TeleportInt), bool_int(TeleportInt, Teleport),
    get_dict(locked, Req, Locked), get_dict(dynamic_closed, Req, DynamicClosed),
    Rules = rules(T,_,_,_,_,_), T1 is T-1,
    findall([Src,Dst],
        ( between(0,T1,Src), between(0,T1,Dst), Src =\= Dst,
          move_check(Rules,Pos,MovesUsed,Locked,DynamicClosed,
                     Src,Dst,Teleport,none,_)
        ), Moves).

dispatch_op(key_unlocked, Req, _{unlocked:Bool}) :-
    rules_from_dict(Req, rules(_,_,_,Restrictions,_,_)),
    get_dict(pos, Req, Pos), get_dict(tower, Req, Tower),
    ( key_tower_unlocked(Restrictions,Pos,Tower) -> Bool = true
    ; Bool = false
    ).

dispatch_op(solver_map, Req, _{optimal:Optimal, states:Count}) :-
    rules_from_dict(Req, Rules),
    get_dict(initial_positions, Req, Initial),
    ( plain_three_goal(Rules,Goal) ->
        three_distance(Initial,Goal,Optimal), Count = 0
    ; Rules = rules(_,_,_,_,_,Target),
      get_distance_map(Rules,Target,Assoc),
      ( get_assoc(Initial,Assoc,D) -> Optimal = D ; Optimal = -1 ),
      assoc_to_list(Assoc,Pairs), length(Pairs,Count)
    ).

dispatch_op(solver_distance, Req, _{distance:Distance}) :-
    rules_from_dict(Req, Rules), get_dict(pos, Req, Pos),
    solver_distance(Rules,Pos,Distance).

dispatch_op(solver_best_move, Req, _{move:Move}) :-
    rules_from_dict(Req, Rules), get_dict(pos, Req, Pos),
    ( solver_best_move(Rules,Pos,Src,Dst) -> Move=[Src,Dst] ; Move=[] ).

dispatch_op(solver_path, Req, _{path:Path}) :-
    rules_from_dict(Req, Rules), get_dict(pos, Req, Pos),
    solver_path(Rules,Pos,Path).

dispatch_op(three_distance, Req, _{distance:Distance}) :-
    get_dict(pos,Req,Pos), get_dict(goal,Req,Goal),
    three_distance(Pos,Goal,Distance).

dispatch_op(three_path, Req, _{path:Path}) :-
    get_dict(pos,Req,Pos), get_dict(goal,Req,Goal), length(Pos,N),
    length(Target,N), maplist(=(Goal),Target),
    Rules=rules(3,N,[],[],none,Target), solver_path(Rules,Pos,Path).

dispatch_op(graph_forward, Req, _{moves:Moves}) :-
    rules_from_dict(Req,Rules), get_dict(pos,Req,Pos),
    findall([Disk,Src,Dst,NewPos],solver_forward(Rules,Pos,Disk,Src,Dst,NewPos),Moves).

dispatch_op(graph_backward, Req, _{states:States}) :-
    rules_from_dict(Req,Rules), get_dict(pos,Req,Pos),
    findall(Pred,predecessor(Rules,Pos,Pred),States).

dispatch_op(classic_moves, Req, _{moves:Moves}) :-
    get_dict(n,Req,N), get_dict(src,Req,Src), get_dict(dst,Req,Dst),
    classic_moves(N,Src,Dst,Moves).

dispatch_op(frame_stewart, Req, _{value:Value}) :-
    get_dict(n,Req,N), get_dict(towers,Req,T), frame_stewart(N,T,Value).

dispatch_op(score, Req, Response) :- score_request(Req,Response).

dispatch_op(tower_factor, Req, _{factor:Factor}) :-
    get_dict(towers,Req,T), Factor is 1.0+0.25*max(0,T-3).

dispatch_op(par_time, Req, _{seconds:Seconds}) :-
    get_dict(optimal,Req,Optimal), Seconds is max(10.0,Optimal*1.2).

dispatch_op(stars, Req, _{stars:Stars,three:Three,two:Two}) :-
    get_dict(moves,Req,Moves), get_dict(optimal,Req,Optimal),
    get_dict(ratio_three,Req,R3), get_dict(ratio_two,Req,R2),
    star_thresholds(Optimal,R3,R2,Three,Two),
    ( Optimal =< 0 -> Stars=1
    ; Moves =< Three -> Stars=3
    ; Moves =< Two -> Stars=2
    ; Stars=1
    ).

dispatch_op(Op, _, _{error:Message}) :-
    term_string(Op,OpText), string_concat("Unknown operation: ",OpText,Message).

move_request(Req,Rules,Pos,Moves,Locked,DynamicClosed,Src,Dst,Teleport) :-
    rules_from_dict(Req,Rules),
    get_dict(pos,Req,Pos), get_dict(moves,Req,Moves),
    get_dict(locked,Req,Locked), get_dict(dynamic_closed,Req,DynamicClosed),
    get_dict(src,Req,Src), get_dict(dst,Req,Dst),
    get_dict(teleport,Req,TeleportInt), bool_int(TeleportInt,Teleport).

/* http_read_json_dict/2 maps JSON booleans to the atoms true/false.
   The browser currently sends 0/1 for numeric flags too, so accept both. */
bool_int(false,false) :- !.
bool_int(0,false) :- !.
bool_int(true,true) :- !.
bool_int(1,true) :- !.
bool_int(_,true).

/* -- rule and state conversion ----------------------------------------- */

rules_from_dict(Dict,rules(T,N,Closed,Restrictions,Limit,Target)) :-
    get_dict(num_towers,Dict,T), get_dict(num_disks,Dict,N),
    get_dict(closed_routes,Dict,ClosedRaw), maplist(pair_from_list,ClosedRaw,Closed),
    get_dict(restrictions,Dict,RestrictionRaw),
    maplist(restriction_from_dict,RestrictionRaw,Restrictions),
    get_dict(move_limit,Dict,LimitRaw),
    ( integer(LimitRaw), LimitRaw >= 1 -> Limit=LimitRaw ; Limit=none ),
    get_dict(target_positions,Dict,Target).

pair_from_list([A,B],A-B).

restriction_from_dict(Dict,res(Tower,Kind,Value,Extra)) :-
    get_dict(tower,Dict,Tower), get_dict(kind,Dict,KindString),
    atom_string(Kind,KindString),
    get_dict(value,Dict,Value), get_dict(extra,Dict,Extra).

valid_position(Pos,T,N) :-
    is_list(Pos), length(Pos,N),
    forall(member(P,Pos),(integer(P),P>=0,P<T)).

target_restrictions_valid(Pos,Restrictions) :-
    forall(member(res(Tower,Kind,Value,_),Restrictions),
        ( tower_height(Pos,Tower,Height),
          ( Kind == max_height -> Height =< Value
          ; Kind == max_size -> forall(disk_on_tower(Pos,Tower,Disk),Disk=<Value)
          ; Kind == parity -> forall(disk_on_tower(Pos,Tower,Disk),Disk mod 2 =:= Value)
          ; true
          )
        )).

disk_on_tower(Pos,Tower,Disk) :- nth0(Index,Pos,Tower), Disk is Index+1.

tower_height(Pos,Tower,Height) :- include(=(Tower),Pos,OnTower), length(OnTower,Height).

top_disk(Pos,Tower,Disk) :-
    nth0(Index,Pos,Tower), Disk is Index+1,
    \+ (nth0(SmallerIndex,Pos,Tower),SmallerIndex<Index), !.

top_disk_or_zero(Pos,Tower,Disk) :- (top_disk(Pos,Tower,D)->Disk=D;Disk=0).

route_pair(A,B,A-B) :- A < B, !.
route_pair(A,B,B-A).

route_open(Closed,A,B) :- route_pair(A,B,Pair), \+ memberchk(Pair,Closed).
route_open(Closed,Dynamic,A,B) :-
    route_open(Closed,A,B), route_pair(A,B,Pair), \+ memberchk(Pair,Dynamic).

set_nth0(Index,List,Value,NewList) :-
    same_length(List,NewList), nth0(Index,List,_,Rest), nth0(Index,NewList,Value,Rest).

/* -- authoritative move validation ------------------------------------ */

move_check(rules(T,_,Closed,Restrictions,Limit,_Target),Pos,Moves,Locked,DynamicClosed,
           Src,Dst,Teleport,Reason,Disk) :-
    ( (Src < 0 ; Src >= T ; Dst < 0 ; Dst >= T) ->
        Reason=invalid_tower, Disk=0
    ; Src =:= Dst ->
        Reason=same_tower, Disk=0
    ; Limit \= none, Moves >= Limit ->
        Reason=move_limit, Disk=0
    ; \+ top_disk(Pos,Src,_) ->
        Reason=empty_source, Disk=0
    ; top_disk(Pos,Src,Disk),
      ( Teleport == false, (memberchk(Src,Locked);memberchk(Dst,Locked)) ->
          Reason=tower_locked
      ; Teleport == false, \+ route_open(Closed,DynamicClosed,Src,Dst) ->
          Reason=route_closed
      ; Teleport == false,
        (key_blocks_tower(Restrictions,Pos,Disk,Src);
         key_blocks_tower(Restrictions,Pos,Disk,Dst)) ->
          Reason=key_locked
      ; top_disk_or_zero(Pos,Dst,TopDst), TopDst > 0, TopDst < Disk ->
          Reason=larger_on_smaller
      ; tower_height(Pos,Dst,Height),
        \+ placement_allowed(Restrictions,Dst,Disk,Height) ->
          Reason=restricted
      ; Reason=none
      )
    ).

key_blocks_tower(Restrictions,Pos,Disk,Tower) :-
    member(res(Tower,key,KeyDisk,KeyTower),Restrictions),
    Disk =\= KeyDisk,
    KeyIndex is KeyDisk-1, nth0(KeyIndex,Pos,CurrentTower),
    CurrentTower =\= KeyTower, !.

key_tower_unlocked(Restrictions,Pos,Tower) :-
    \+ ( member(res(Tower,key,KeyDisk,KeyTower),Restrictions),
         KeyIndex is KeyDisk-1, nth0(KeyIndex,Pos,CurrentTower),
         CurrentTower =\= KeyTower
       ).

placement_allowed(Restrictions,Tower,Disk,Height) :-
    forall(member(res(Tower,Kind,Value,_),Restrictions),
        ( Kind == max_height -> Height < Value
        ; Kind == max_size -> Disk =< Value
        ; Kind == parity -> Disk mod 2 =:= Value
        ; true
        )).

/* -- classic Hanoi, multi-tower search, and hints ---------------------- */

classic_moves(0,_,_,[]) :- !.
classic_moves(N,Src,Dst,Moves) :-
    N > 0, Aux is 3-Src-Dst, N1 is N-1,
    classic_moves(N1,Src,Aux,Left),
    classic_moves(N1,Aux,Dst,Right),
    append(Left,[[Src,Dst]|Right],Moves).

three_distance(Pos,Goal,Distance) :-
    reverse(Pos,LargestFirst), three_distance_rev(LargestFirst,Goal,Distance).

three_distance_rev([],_,0).
three_distance_rev([Position|Rest],Target,Distance) :-
    length([Position|Rest],K),
    ( Position =:= Target ->
        three_distance_rev(Rest,Target,Distance)
    ; Other is 3-Position-Target,
      three_distance_rev(Rest,Other,Tail),
      Power is 1 << (K-1), Distance is Power+Tail
    ).

plain_three_goal(rules(3,N,[],[],_,Target),Goal) :-
    length(Target,N), nth0(0,Target,Goal),
    forall(member(P,Target),P=:=Goal).

solver_target(rules(_,_,_,_,_,Target),Target).

solver_forward(rules(T,N,Closed,Restrictions,_,_),Pos,Disk,Src,Dst,NewPos) :-
    T1 is T-1, between(0,T1,Src), top_disk(Pos,Src,Disk),
    between(0,T1,Dst), Src =\= Dst,
    route_open(Closed,Src,Dst),
    top_disk_or_zero(Pos,Dst,TopDst), (TopDst=:=0;TopDst>Disk),
    tower_height(Pos,Dst,Height), placement_allowed(Restrictions,Dst,Disk,Height),
    \+ key_blocks_tower(Restrictions,Pos,Disk,Src),
    \+ key_blocks_tower(Restrictions,Pos,Disk,Dst),
    Index is Disk-1, set_nth0(Index,Pos,Dst,NewPos), N >= 1.

/* The predecessor relation is the exact reverse of every statically legal
   move. Dynamic Chaos locks are transient and intentionally excluded from
   the optimality oracle, as in the original game. */
predecessor(rules(T,N,Closed,Restrictions,_,_),Pos,Pred) :-
    T1 is T-1, between(0,T1,Dst), top_disk(Pos,Dst,Disk),
    between(0,T1,Src), Src =\= Dst,
    route_open(Closed,Src,Dst),
    top_disk_or_zero(Pos,Src,TopSrc), (TopSrc=:=0;TopSrc>Disk),
    tower_height(Pos,Dst,HeightNow), HeightBefore is HeightNow-1,
    placement_allowed(Restrictions,Dst,Disk,HeightBefore),
    \+ key_blocks_tower(Restrictions,Pos,Disk,Src),
    \+ key_blocks_tower(Restrictions,Pos,Disk,Dst),
    Index is Disk-1, set_nth0(Index,Pos,Src,Pred), N >= 1.

/* Two-list FIFO queue for breadth-first search. */
q_put(X,q(Front,Back),q(Front,[X|Back])).
q_get(q([X|Front],Back),X,q(Front,Back)) :- !.
q_get(q([],Back),X,q(Front,[])) :- reverse(Back,[X|Front]).

get_distance_map(Rules,Target,Map) :-
    ( distance_cache(Rules,Target,Existing) -> Map=Existing
    ; empty_assoc(A0), put_assoc(Target,A0,0,A1),
      q_put(Target,q([],[]),Queue),
      bfs_loop(Queue,A1,Rules,Map),
      assertz(distance_cache(Rules,Target,Map)),
      aggregate_all(count,distance_cache(_,_,_),CacheCount),
      ( CacheCount > 24 ->
          retractall(distance_cache(_,_,_)), assertz(distance_cache(Rules,Target,Map))
      ; true
      )
    ).

bfs_loop(Queue,Visited,Rules,Result) :-
    ( q_get(Queue,State,Queue1) ->
        get_assoc(State,Visited,Depth),
        findall(Pred,predecessor(Rules,State,Pred),Preds),
        add_predecessors(Preds,Depth,Queue1,Visited,Queue2,Visited2),
        bfs_loop(Queue2,Visited2,Rules,Result)
    ; Result=Visited
    ).

add_predecessors([],_,Queue,Visited,Queue,Visited).
add_predecessors([State|Rest],Depth,Q0,A0,Q,A) :-
    ( get_assoc(State,A0,_) -> Q1=Q0, A1=A0
    ; NextDepth is Depth+1, put_assoc(State,A0,NextDepth,A1), q_put(State,Q0,Q1)
    ),
    add_predecessors(Rest,Depth,Q1,A1,Q,A).

solver_distance(Rules,Pos,Distance) :-
    ( plain_three_goal(Rules,Goal) -> three_distance(Pos,Goal,Distance)
    ; solver_target(Rules,Target), get_distance_map(Rules,Target,Map),
      ( get_assoc(Pos,Map,D) -> Distance=D ; Distance = -1 )
    ).

solver_best_move(Rules,Pos,Src,Dst) :-
    solver_distance(Rules,Pos,Here), integer(Here), Here > 0,
    solver_forward(Rules,Pos,_Disk,Src,Dst,NewPos),
    solver_distance(Rules,NewPos,There), There =:= Here-1, !.

solver_path(Rules,Pos,Path) :-
    solver_distance(Rules,Pos,Distance),
    ( Distance =< 0 -> Path=[]
    ; solver_best_move(Rules,Pos,Src,Dst),
      solver_forward(Rules,Pos,_Disk,Src,Dst,NewPos),
      solver_path(Rules,NewPos,Tail), Path=[[Src,Dst]|Tail]
    ).

frame_stewart(N,_,0) :- N =< 0, !.
frame_stewart(1,_,1) :- !.
frame_stewart(N,3,Value) :- N > 1, !, Value is (1 << N)-1.
frame_stewart(N,T,Value) :-
    N > 1, T >= 3, N1 is N-1,
    findall(Candidate,
        ( between(1,N1,K), Remaining is N-K,
          frame_stewart(K,T,First), T1 is T-1,
          frame_stewart(Remaining,T1,Second),
          Candidate is 2*First+Second
        ), Candidates),
    min_list(Candidates,Value).

/* -- scoring ------------------------------------------------------------- */

score_request(Req,Response) :-
    get_dict(num_disks,Req,N), get_dict(num_towers,Req,T),
    get_dict(moves,Req,Moves), get_dict(optimal,Req,Optimal),
    get_dict(elapsed,Req,Elapsed), get_dict(time_limit,Req,TimeLimit),
    get_dict(time_left,Req,TimeLeft), get_dict(best_combo,Req,Combo),
    get_dict(use_combo,Req,UseComboInt), get_dict(use_speed,Req,UseSpeedInt),
    get_dict(hints,Req,Hints), get_dict(power_moves,Req,Power),
    get_dict(mistakes,Req,Mistakes), get_dict(objectives_done,Req,Objectives),
    get_dict(assisted,Req,AssistedInt), get_dict(free_hints,Req,FreeHintsInt),
    bool_int(UseComboInt,UseCombo), bool_int(UseSpeedInt,UseSpeed),
    bool_int(AssistedInt,Assisted), bool_int(FreeHintsInt,FreeHints),
    ( Assisted == true ->
        Items=[_{label:"Auto-solve used",points:0,detail:"Demonstrations don't score or set records."}],
        Total=0, Multiplier=1.0, Counts = false
    ;
        BaseRaw is 100*N*(1+0.25*max(0,T-3)), round_even(BaseRaw,Base),
        format(string(BaseDetail),"~d disks x ~d towers",[N,T]),
        BaseItem=_{label:"Puzzle size",points:Base,detail:BaseDetail},
        score_efficiency(Optimal,Moves,Efficiency,EfficiencyItems),
        score_speed(UseSpeed,TimeLimit,TimeLeft,Optimal,Elapsed,Speed,SpeedItems),
        Subtotal is Base+Efficiency+Speed,
        combo_score(UseCombo,Combo,Subtotal,Core,Multiplier,ComboItems),
        ObjectivePoints is 150*Objectives,
        objective_items(Objectives,ObjectiveItems),
        hint_penalty(Hints,FreeHints,HintPenalty,HintItems),
        power_penalty(Power,PowerPenalty,PowerItems),
        mistake_penalty(Mistakes,MistakePenalty,MistakeItems),
        TotalRaw is Core+ObjectivePoints-HintPenalty-PowerPenalty-MistakePenalty,
        Total is max(0,TotalRaw),
        append([[BaseItem],EfficiencyItems,SpeedItems,ComboItems,ObjectiveItems,
                HintItems,PowerItems,MistakeItems],Items),
        Counts = true
    ),
    Response=_{items:Items,multiplier:Multiplier,total:Total,counts:Counts}.

score_efficiency(Optimal,Moves,Points,Items) :-
    ( Optimal > 0 ->
        Ratio is min(1.0,Optimal/max(1,Moves)),
        round_even(600*Ratio*Ratio,Points),
        ( Moves =< Optimal ->
            format(string(Detail),"~d moves vs ~d minimum - perfect!",[Moves,Optimal])
        ; format(string(Detail),"~d moves vs ~d minimum",[Moves,Optimal])
        ),
        Items=[_{label:"Efficiency",points:Points,detail:Detail}]
    ; Points=0, Items=[]
    ).

score_speed(false,_,_,_,_,0,[]) :- !.
score_speed(true,TimeLimit,TimeLeft,_,_,Points,Items) :-
    TimeLimit > 0, TimeLeft > -9990, !,
    Raw is 400*max(0.0,TimeLeft)/TimeLimit, round_even(Raw,Points),
    Remaining is max(0.0,TimeLeft),
    format(string(Detail),"~1f s of ~0f s left",[Remaining,TimeLimit]),
    Items=[_{label:"Time remaining",points:Points,detail:Detail}].
score_speed(true,_,_,Optimal,Elapsed,Points,Items) :-
    Optimal > 0, !,
    Par is max(10.0,Optimal*1.2), Raw is 300*max(0.0,1-Elapsed/(3*Par)),
    round_even(Raw,Points),
    format(string(Detail),"~1f s (par ~0f s)",[Elapsed,Par]),
    Items=[_{label:"Speed",points:Points,detail:Detail}].
score_speed(_,_,_,_,_,0,[]).

combo_score(false,_,Subtotal,Subtotal,1.0,[]) :- !.
combo_score(true,Combo,Subtotal,Core,Multiplier,[Item]) :-
    Multiplier is 1.0+min(1.0,0.1*(Combo//3)),
    round_even(Subtotal*Multiplier,Core), Bonus is Core-Subtotal,
    format(string(Label),"Combo x~1f",[Multiplier]),
    format(string(Detail),"Best streak of ~d efficient moves",[Combo]),
    Item=_{label:Label,points:Bonus,detail:Detail}.

objective_items(Count,[Item]) :- Count > 0, !,
    Points is 150*Count,
    format(string(Detail),"~d completed (+150 each)",[Count]),
    Item=_{label:"Objectives",points:Points,detail:Detail}.
objective_items(_,[]).

hint_penalty(Hints,false,Penalty,[Item]) :- Hints > 0, !,
    Penalty is min(200,50*Hints),
    format(string(Detail),"~d used (-50 each, max -200)",[Hints]),
    Item=_{label:"Hints",points: -Penalty,detail:Detail}.
hint_penalty(_,_,0,[]).

power_penalty(Power,Penalty,[Item]) :- Power > 0, !,
    Penalty is 75*Power,
    format(string(Detail),"~d used (-75 each)",[Power]),
    Item=_{label:"Power moves",points: -Penalty,detail:Detail}.
power_penalty(_,0,[]).

mistake_penalty(Mistakes,Penalty,[Item]) :- Mistakes > 0, !,
    Penalty is min(100,10*Mistakes),
    format(string(Detail),"~d (-10 each, max -100)",[Mistakes]),
    Item=_{label:"Illegal attempts",points: -Penalty,detail:Detail}.
mistake_penalty(_,0,[]).

round_even(Value,Rounded) :-
    Floor is floor(Value), Fraction is Value-Floor,
    ( Fraction < 0.5 -> Rounded=Floor
    ; Fraction > 0.5 -> Rounded is Floor+1
    ; 0 is Floor mod 2 -> Rounded=Floor
    ; Rounded is Floor+1
    ).

star_thresholds(Optimal,R3,R2,Three,Two) :-
    ( Optimal =< 0 -> Three=1, Two=2
    ; A is max(Optimal,ceiling(Optimal*R3-1.0e-9)),
      B is max(A,ceiling(Optimal*R2-1.0e-9)), Three=A, Two=B
    ).
