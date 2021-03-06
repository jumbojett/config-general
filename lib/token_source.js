var fs = require('fs'),
    console = require('console'),
    util = require('util'),
    emitter = require('events').EventEmitter,
    fu = require('./file-utils');

/**
 * constructor - will document options in higher-level code.
 */
function tokenizer(options) {
  // defaults
  var base_options = {
    'SplitPolicy': 'guess',
    'CComments': 'true',
    'SlashIsDirectory': false,
    'UseApacheInclude': false
  };

  // this is an event emitter
  emitter.apply(this);

  // implementation details
  this.buffer = [];      // actual input buffer - before we tokenize, first
                         // chunk of input/loaded file/etc goes here
  this.token_stack = []; // we feed the rest of the system from tokens here
  this.cpos = 0;         // used in the routine to build the initial
                         // contents of the token-stack
  this.filename = "";    // originally stored the current input filename
                         // obsolete and scheduled to go away
  this.options = base_options; // import the defaults
  this.events = [ 'tagopen', 'tagclose', 'keyvalue', 'end', 'includereq', 'selfclose' ]; // the events we support. Obsolete, but not likely to go away

  // scoping rules mean we need the following
  var self = this;
  // so we can do things like this to import the options we were
  // actually passed.
  Object.keys(options).forEach( function( e, i, o ) {
    self.options[e] = options[e];
  });

  // important options - DefaultConfig is a newline delimited string
  // containing a valid config to use as the base. Put it in the buffer
  // to be tokenized.
  if( this.options.DefaultConfig !== undefined )
    this.buffer = this.options.DefaultConfig.split("\n");

  // the 'String' parameter can either contain something similar to
  // DefaultConfig or be an array of lines. Handle it properly.
  if( this.options.String !== undefined ) {
    if( Array.isArray(this.options.String) ) {
      if( this.buffer.length > 0 )
        this.buffer = this.buffer.concat(this.process(this.options.String));
      else
        this.buffer = this.process(this.options.String);
    } else {
      // process the string into an array so we can properly feed the beast
      // each tag, heredoc opening, etc... gets a separate entry in the
      // buffer. We do no processing beyond that. However, all we can do
      // is split by newline and hope that works
      var temp;
      if( /\n/g.test(this.options.String ) )
        temp = this.options.String.split("\n");
      else
        temp = [ this.options.String ];

      if( this.buffer.length > 0 )
        this.buffer = this.buffer.concat(this.process(temp));
      else
        this.buffer = this.process(temp);
    }
  } else if( this.options.ConfigFile ) {
    // passed a single filename and not any of the other options
    var tb;
    this.filename = this.options.ConfigFile;

    tb = fu.getFile( this.filename ).split('\n');
    if( this.buffer.length > 0 )
      this.buffer = this.buffer.concat(this.process(tb));
    else
      this.buffer = this.process(tb);
  } else {
    throw new Error('no input to process');
  }

  // it strikes me that a hell of a lot of the calls to 'process'
  // could be moved out here if I made the temporary buffer something
  // with a wider scope.
  this.token_stack = this.token_stack.concat(this.build_stack(this.buffer) );
}

// make sure we inherit everything possible from the event emitter base
tokenizer.prototype = Object.create( emitter.prototype );

/*
 * The following functions are cleanly named helper-functions
 * (for the most part) - any that require special notice will have it
 */
function get_tag_contents(line) {
  var match = line.match(/\s*<(.*)>.*/);
  return match[1];
}

// read a single or double-quoted string and return it with
// escapes managed.
function get_string(line) {
  var cp = 1;
  var out = "";
  var ls = line[0];

  while( cp < line.length ) {
    if( line[cp] != ls ||
        (line[cp] == ls &&
         line[cp - 1] == '\\') )
      out = out + line[cp];
    else
      return out;

    cp++;
  }

  throw new Error('end of input encountered before end of string');
}

// this reads a line of the input and returns everything that is
// not a comment on the line. Only works for hash-mark comments at
// the end of the line. Special care has to be taken because the
// hash-mark, like every other special character, can be escaped to
// no-longer mean 'start of comment'

function get_data_no_comment(line) {
  var cp = 0;
  var out = "";

  while( cp < line.length ) {
    if( line[cp] != '#' ) {
      out = out + line[cp];
    } else if(line[cp] == '#' && line[cp - 1] == '\\') {
      out = out + line[cp];
    } else {
      return out;
    }
    cp++;
  }
  return out;
}

function read_heredoc(buffer,start_pos) {
  var work = buffer[start_pos];
  var bpos = start_pos;

  var t = work.split(/<</);
  var hdm = new RegExp('^'+t[1].trim()+'$');
  var lb = "";
  bpos++;
  work = buffer[bpos].trim();
  while( !hdm.test(work) ) {
    if( lb !== "" )
      lb += "\n"+work;
    else
      lb = work;

    bpos++;
    if( bpos >= buffer.length )
      return [buffer.length, undefined];
    work = buffer[bpos].trim();
  }

  var b = t[0].trim();

  if( b.slice(-1) == '=' )
    b = b.slice(0,-1).trim();

  var rv = {};
  rv.name = b;
  rv.value = lb;

  return [bpos, rv];
}

// heuristic to help simplify the code
function tag_type(buff,sid) {
  if( buff[0] == '/' )
    return 'closing';
  else if( buff.slice(-1) == '/' && !sid )
    return 'selfclosing';
  else //assume it's an open tag
    return 'opening';
}

// read the tag name and return it
// separated out as a helper because
// this could get tricky if the semantics
// change any
function tag_name(buff) {
  var r;
  if( buff[0] == '"' ) {
    r = get_string(buff);
  } else {
    r = buff.split(/\s/)[0];
  }
  r = r.trim();
  return r;
}

// semantically similar to 'read_heredoc'
// reads until it finds a line that is not
// ended with an 'escaped newline'
function read_continued_line(buffer,start) {
  var work = buffer[start];
  var bpos = start;
  var tb = "";

  while( work.slice(-1) == '\\' ) {
    if( tb !== undefined )
      tb = tb + work.trimLeft();
    else
      tb = work.trimLeft();

    tb = tb.slice(0,-1).trimLeft();
    bpos++;
    work = buffer[bpos].trim();
  }
  tb = tb + work.trimLeft();

  return [tb,bpos];
}

// not a good name - this actually applies the current
// 'SplitPolicy' and 'SplitDelimiter' options - code
// is, as far as I can tell, fully compatible with the
// original Perl version, though I think that used a
// single regular expression to split the line
// @line is the line to split
// @pol is the SplitPolicy ('guess' if undefined)
// @delim is the SplitDelimiter (varies base on @pol)
function do_split( line, pol, delim ) {
  // rs is the result
  var rs = [], temp;

  // if we are not given a policy, then the policy is to
  // guess if it's meant to be split at an equals-sign or
  // the first whitespace.
  if( pol === undefined )
    pol = 'guess';

  if( pol == 'guess' ) {
    // there has to be a better way, but this is expedient.
    // prefer the split that leads to a shorter key-name -
    // but only worry about that if the input line has an
    // equals sign in it
    if( /\s*=\s*/.test(line) ) {
      var tmp = line.split('=')[0].trim();
      var tmp2 = line.split(/\s/)[0].trim();
      if( tmp.length <= tmp2.length ) {
        temp = line.split('=')[0];
        rs.push(temp);
        rs.push(line.replace(temp,'').trim());
      } else {
        temp = line.split(/\s/)[0];
        rs.push(temp);
        rs.push(line.replace(temp,'').trim());
      }
    } else {
        temp = line.split(/\s/)[0];
        rs.push(temp);
        rs.push(line.replace(temp,'').trim());
    }
  } else if( pol == 'whitespace' ) {
        temp = line.split(/\s/)[0];
        rs.push(temp);
        rs.push(line.replace(temp,'').trim());
  } else if( pol == 'equalsign' ) {
    temp = line.split('=')[0];
    rs.push(temp);
    rs.push(line.replace(temp,'').trim());
  } else if( pol == 'custom' ) {
    // the custom split-policy is simple - the delimiter we were given
    // is, basically, a regular expression and we shall use it as such.
    var splitter;
    if( delim !== undefined )
      splitter = new RegExp(delim);
    else
      throw new Error('SplitPolicy set to \'custom\' but no SplitDelimiter supplied');

    temp = line.split(splitter)[0];
    rs.push(temp);
    rs.push(line.replace(temp,'').replace(splitter,'').trim());
  }

  // remove end-of-line comments, but only in very explicit situations
  // this solved a couple of bugs turned up in testing, but which ones
  // escapes me
  var tccs = new RegExp( '/\\*.*\\*/$' );
  var tcos = new RegExp( '#.*$' );

  if( tccs.test(rs[1]) ) {
    rs[1] = rs[1].replace(tccs,'');
    rs[1] = rs[1].trim();
  } else if( tcos.test(rs[1]) &&
             !/\\#.*$/.test(rs[1]) ) {
    rs[1] = rs[1].replace(tcos,'');
    rs[1] = rs[1].trim();
  }

  return rs;
}

// tokenize an input stream and stick it on the stack of tokens
// this is how we handle includes and don't have to worry about
// secondary parsers and things like that.
tokenizer.prototype.tokenize_and_insert = function( data ) {
  var wb = this.process(data);
  var ms = this.build_stack(wb);
  ms.push( { type: 'includeend' } );
  this.token_stack = ms.concat(this.token_stack);
};

// strip blank lines and lines that are purely comments
// unless that blank line follows an escaped newline
tokenizer.prototype.process = function( data ) {
  var rv = [];
  var pos = 0;

  var temp = data;

  var current = temp[pos];

  while( pos < temp.length ) {
    if( !(/^\s*\/\/.*$/.test(current)) &&
        !(/^\s+$/.test(current)) &&
        !(/^\s*(?:#.*)?$/.test(current)) &&
          current !== '' ) {
      var ic;
      var td;
      var xx;

      if( /<</.test(current) && !(/>>/.test(current))) {
        // C-style comments are not comments when inside a here-doc,
        // they are content.
        td = current.match(/\s*(.*)\s*<<\s*(.*)\s*(?:(?:#|\/\/)?.*)$/)[2];
        td = td.trim();

        xx = new RegExp('^\\s*'+td+'\\s*$');
        while( !(xx.test(current) ) )  {
          rv.push(current);
          pos++;
          current = temp[pos];
          if( pos >= temp.length )
            return rv;
        }
        rv.push(current);
      } else if( this.options.CComments && /^\s*\/\*.*$/.test(current) ) {
        // if the CComments option is set to 'true' (the default) then
        // we strip all C-style comments that are not in a here-doc and
        // don't have anything else on the line with them.
        pos++;
        current = temp[pos];
        while( !(/^.*\*\/\s*$/.test(current)) &&
                pos < temp.length ) {
          pos++;
          current = temp[pos];
        }
      } else {
        rv.push(current);
      }
      pos++;
      current = temp[pos];
    } else {
      // blank line following an escaped newline must be retained
      if( /^\s*$/.test(current) &&
          /^.*\\$/.test(temp[pos - 1]) ) // the previous line was continued
          rv.push(current);

      pos++;
      current = temp[pos];
    }
  }

  return rv;
};

// turn the processed input into a stack of tokens
tokenizer.prototype.build_stack = function(input) {
  var self = this;
  var buff = [];

  if( input.length === 0 )
    return [];

  var wb = input;
  var bpos = 0;

  while( bpos < wb.length ) {
    var work = wb[bpos].trim();
    var temp_buff = "";
    if( /<</.test(work) && !(/>>/.test(work))) {
      // heredoc
      var d = read_heredoc(wb,bpos);
      if( d[1] === undefined )
        return buff;

      bpos = d[0];
      buff.push( { type: 'keyvalue', value: { key: d[1].name, value: d[1].value }});
    } else if( /<</.test(work) && />>/.test(work) ) {
      // specific type of processing directive.
      // right now the only existing one is 'include'
      var rv = { type: 'include' };
      var mm = work.match(/^<<(.*)>>(?:\s*#.*)?$/)[1];
      if( mm.split(/\s/)[0].toLowerCase() != 'include' )
        throw new Error('unknown processing directive found in input');
      rv.value = mm.replace('include','').trim();
      buff.push(rv);
    } else if( /^\s*</.test(work) ) {
      // tag of some sort
      var rr = {};
      temp_buff = get_tag_contents(work);
      rr.tt = tag_type(temp_buff,self.options.SlashIsDirectory===undefined?false:self.options.SlashIsDirectory);

      if( rr.tt == 'closing' )
        temp_buff = temp_buff.slice(1);

      rr.tn = tag_name(temp_buff);

      temp_buff = temp_buff.replace(rr.tn,'').trim();

      // this solved a bug that showed up thanks to the test suite.
      // don't recall the specifics, but this is now, basically,
      // a chunk of voodoo programming
      if( temp_buff.slice(0,2) == '""' )
        temp_buff = temp_buff.slice(2).trim();

      if( rr.tt == 'selfclosing' && temp_buff.slice(-1) == '/' )
        temp_buff = temp_buff.slice(0,-1);

      if( /^\".*\"$/.test(temp_buff) ) // we've still got a string left
        rr.td = get_string(temp_buff);
      else
        rr.td = temp_buff.trim();

      if( rr.td === "" || /^\s+$/.test(rr.td) )
        rr.td = undefined;

      buff.push( { type: rr.tt, value: { name: rr.tn, data: rr.td } } );
    } else {
      // key-value pair. This is the least tricky one.
      // 'guess' or 'whitespace' when there is no equalsign
      // present will split at the first piece of whitespace
      // regardless of whether the opening starts with any
      // form of quote
      var rs;
      work = get_data_no_comment(work);
      if( work.slice(-1) == '\\' &&
          work.slice(-2) != '\\\\' ) {
        rs = read_continued_line(wb,bpos);
        work = rs[0];
        bpos = rs[1];
      }

      if( temp_buff === "" )
        temp_buff = work.trimLeft();

      temp_buff = temp_buff.trimLeft();

      rs = do_split( temp_buff, self.options.SplitPolicy, self.options.SplitDelimiter );

      // Our default include-style is to use a specially formatted tag
      // that could, in the future, be used for other types of processing
      // directive. Apache does it as a special key-value pair.
      if( ['include', 'includeoptional'].includes(rs[0].toLowerCase()) &&
          self.options.UseApacheInclude ) {
        if( rs[1].trim()[0] == '"' ) {
          buff.push( { type: 'include', value: get_string(rs[1].trim()) } );
        } else {
          buff.push( { type: 'include', value: rs[1].trim() } );
        }
      } else {
        if( rs[1] !== undefined &&
            rs[1].trim() !== "" ) {
          // properly do this
          temp_buff = rs[1].trim();

          if( temp_buff[0] == '=' ) {
            temp_buff = temp_buff.slice(1).trimLeft();
          }

          temp_buff = temp_buff.trim();
          if( temp_buff[0] == '"' )
            temp_buff = get_string(temp_buff);

          buff.push( { type: 'keyvalue', value: { key: rs[0].trim(), value: temp_buff } } );
        } else {
          buff.push( { type: 'keyvalue', value: { key: rs[0].trim(), value: undefined } } );
        }
      }
    }
    bpos++;
  }
  return buff;
};

// pull our internal token off the stack and
// interpret it into what the rest of the code
// expects, then return it.
tokenizer.prototype.get_token = function() {
  var self = this;
  if( self.token_stack.length === 0 ) {
    return { type: 'end' };
  }

  var cl = this.token_stack.shift();
  var rv = {};

  switch(cl.type) {
    case 'include':
    rv.type = 'includereq';
    rv.pattern = cl.value;
    break;
    case 'opening':
    rv.type = 'tagopen';
    rv.tagname = cl.value.name;
    rv.data = cl.value.data;
    break;
    case 'closing':
    rv.type = 'tagclose';
    rv.tagname = cl.value.name;
    break;
    case 'selfclosing':
    rv.type = 'selfclose';
    rv.tagname = cl.value.name;
    rv.data = cl.value.data;
    break;
    case 'keyvalue':
    rv.type = 'keyvalue';
    rv.name = cl.value.key;
    rv.value = cl.value.value;
    break;
    case 'includeend':
    rv = cl;
    break;
  }

  return rv;
};

// actual event-generator. Calls this.get_token()
// and generates the proper event with the proper
// parameters so the parser can actually function.
tokenizer.prototype.next = function() {
  var self = this;

  var work = self.get_token();
  var rv = {};

  switch(work.type) {
    case 'tagopen':
    case 'selfclose':
    rv.name = work.tagname;
    if( work.data !== undefined )
      rv.specname = work.data;
    break;
    case 'tagclose':
    rv = work.tagname;
    break;
    case 'keyvalue':
    rv.name = work.name;
    rv.value = work.value;
    break;
    case 'includeend':
    case 'end':
    break;
    case 'includereq':
    rv.pattern = work.pattern;
    break;
    default:
    console.log(util.inspect(work));
    throw new Error('unknown data returned from get_token!');
  }

  if( work.type != 'end' &&
    work.type != 'includeend' )
    self.emit( work.type, rv );
  else if( work.type == 'includeend' )
    self.emit( 'includeend' );
  else
    self.emit( 'end' );
};

module.exports = tokenizer;
