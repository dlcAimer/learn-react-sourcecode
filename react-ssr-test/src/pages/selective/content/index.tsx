import * as React from 'react';

function Content() {
  const [state, setState] = React.useState(0);

  const onClick = () => {
    setState((state) => {
      debugger;
      return state + 1;
    });
    setState((state) => {
      debugger;
      return state + 1;
    });
  };

  return (
    <section className='flex-1 h-full ml-4 bg-blue-500 flex flex-col justify-center items-center text-base text-white'>
      content
    </section>
  );
}

export default Content;
